/**
 * S3-Compatible Storage Client
 * Supports MinIO (dev) and Supabase Storage (prod)
 */
import {
    S3Client,
    PutObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    type PutObjectCommandInput,
    type _Object as S3Object,
    type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { lookup } from 'mime-types';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { attachOpCounter } from './op-counter.js';

// -----------------------------------------------------------------------------
// Two-tier storage: primary (hot) is the bucket every upload lands in. cold is
// an optional secondary bucket the storage worker can move purge candidates to
// instead of deleting them outright. Both are S3-compatible — provider doesn't
// matter (R2, AWS S3, Supabase, MinIO, B2, Wasabi, …).
// -----------------------------------------------------------------------------

export type StorageTier = 'primary' | 'cold';

const primaryClient = new S3Client({
    endpoint: config.storageEndpoint,
    region: config.storageRegion,
    credentials: {
        accessKeyId: config.storageAccessKey,
        secretAccessKey: config.storageSecretKey,
    },
    forcePathStyle: true,
});

const coldClient = config.coldStorageEnabled && config.coldStorageEndpoint
    ? new S3Client({
        endpoint: config.coldStorageEndpoint,
        region: config.coldStorageRegion,
        credentials: {
            accessKeyId: config.coldStorageAccessKey ?? '',
            secretAccessKey: config.coldStorageSecretKey ?? '',
        },
        forcePathStyle: true,
    })
    : null;

// Attach the op counter to every constructed S3 client so we can track
// Class A / Class B operation counts against the free-tier budget. Adds one
// in-memory increment per `client.send(...)`; no call-site changes needed.
attachOpCounter(primaryClient, 'primary');
if (coldClient) attachOpCounter(coldClient, 'cold');

// Backwards-compat alias for existing callers that imported s3Client directly.
const s3Client = primaryClient;

export function isColdTierConfigured(): boolean {
    return Boolean(
        config.coldStorageEnabled &&
        config.coldStorageEndpoint &&
        config.coldStorageBucket &&
        config.coldStorageAccessKey &&
        config.coldStorageSecretKey
    );
}

interface TierBinding {
    client: S3Client;
    bucket: string;
    publicUrl: string;
}

function bindingFor(tier: StorageTier): TierBinding {
    if (tier === 'cold') {
        if (!coldClient || !config.coldStorageBucket || !config.coldStoragePublicUrl) {
            throw new Error('Cold storage tier is not configured');
        }
        return {
            client: coldClient,
            bucket: config.coldStorageBucket,
            publicUrl: config.coldStoragePublicUrl,
        };
    }
    return {
        client: primaryClient,
        bucket: config.storageBucket,
        publicUrl: config.storagePublicUrl,
    };
}

/**
 * Generate deterministic storage key for content artifacts.
 * The key path is identical across tiers — only the bucket changes.
 */
export function getStorageKey(
    contentItemId: string,
    artifactType: 'original' | 'processed' | 'thumbnail' | 'audio' | 'hls',
    extension: string
): string {
    return `content/${contentItemId}/${artifactType}.${extension}`;
}

/**
 * Get public URL for a storage key. Defaults to the primary tier so existing
 * callers don't need to change.
 */
export function getPublicUrl(key: string, tier: StorageTier = 'primary'): string {
    const { publicUrl } = bindingFor(tier);
    return `${publicUrl.replace(/\/$/, '')}/${key}`;
}

function isMissingObjectError(error: unknown): boolean {
    const err = error as {
        name?: string;
        code?: string;
        $metadata?: { httpStatusCode?: number };
    };
    return (
        err?.$metadata?.httpStatusCode === 404 ||
        err?.name === 'NotFound' ||
        err?.name === 'NoSuchKey' ||
        err?.code === 'NotFound' ||
        err?.code === 'NoSuchKey'
    );
}

/**
 * Check if an object exists in storage
 */
export async function objectExists(key: string, tier: StorageTier = 'primary', signal?: AbortSignal): Promise<boolean> {
    const { client, bucket } = bindingFor(tier);
    try {
        await client.send(
            new HeadObjectCommand({
                Bucket: bucket,
                Key: key,
            }),
            { abortSignal: signal },
        );
        return true;
    } catch (error) {
        if (isMissingObjectError(error)) {
            return false;
        }
        throw error;
    }
}

/**
 * HEAD an object and return its size, or 0 if missing.
 */
export async function getObjectSize(key: string, tier: StorageTier = 'primary'): Promise<number> {
    const { client, bucket } = bindingFor(tier);
    try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return head.ContentLength ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Stream an object out of S3. Used by the move-to-cold flow.
 */
export async function getObjectStream(key: string, tier: StorageTier = 'primary'): Promise<{
    body: NodeJS.ReadableStream;
    size: number;
    contentType?: string;
}> {
    const { client, bucket } = bindingFor(tier);
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!resp.Body) {
        throw new Error(`Object ${key} returned an empty body`);
    }
    return {
        body: resp.Body as NodeJS.ReadableStream,
        size: resp.ContentLength ?? 0,
        contentType: resp.ContentType,
    };
}

/**
 * Upload a file to storage with retry logic
 */
export async function uploadFile(
    key: string,
    filePath: string,
    contentType?: string,
    tier: StorageTier = 'primary',
    signal?: AbortSignal,
): Promise<string> {
    const { client, bucket } = bindingFor(tier);
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) throw signal.reason;
        try {
            const fileStats = await stat(filePath);
            const fileStream = createReadStream(filePath);
			const abortStream = () => fileStream.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
			signal?.addEventListener('abort', abortStream, { once: true });

            const mimeType = contentType || lookup(filePath) || 'application/octet-stream';

            const params: PutObjectCommandInput = {
                Bucket: bucket,
                Key: key,
                Body: fileStream,
                ContentType: mimeType,
                ContentLength: fileStats.size,
            };

            try {
                await client.send(new PutObjectCommand(params), { abortSignal: signal });
            } finally {
                signal?.removeEventListener('abort', abortStream);
            }

            const publicUrl = getPublicUrl(key, tier);

            logger.info('File uploaded to storage', {
                key,
                tier,
                size: fileStats.size,
                contentType: mimeType,
                url: publicUrl,
            });

            return publicUrl;
        } catch (error) {
            lastError = error as Error;
            logger.warn(`Upload attempt ${attempt} failed`, {
                key,
                tier,
                error: lastError.message,
            });

            if (attempt < maxRetries && !signal?.aborted) {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, Math.pow(2, attempt) * 1000);
                    signal?.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(signal.reason);
                    }, { once: true });
                });
            }
        }
    }

    throw lastError || new Error('Upload failed after retries');
}

/**
 * Upload a buffer to storage with retry logic
 */
export async function uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType: string,
    tier: StorageTier = 'primary'
): Promise<string> {
    const { client, bucket } = bindingFor(tier);
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const params: PutObjectCommandInput = {
                Bucket: bucket,
                Key: key,
                Body: buffer,
                ContentType: contentType,
                ContentLength: buffer.length,
            };

            await client.send(new PutObjectCommand(params));

            const publicUrl = getPublicUrl(key, tier);

            logger.info('Buffer uploaded to storage', {
                key,
                tier,
                size: buffer.length,
                contentType,
                url: publicUrl,
            });

            return publicUrl;
        } catch (error) {
            lastError = error as Error;
            logger.warn(`Upload attempt ${attempt} failed`, {
                key,
                tier,
                error: lastError.message,
            });

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }

    throw lastError || new Error('Upload failed after retries');
}

// Recovery artifacts are operator-only payloads. They use provider-managed
// server-side encryption and callers verify the provider's HEAD response
// before the CMS is allowed to ledger the artifact as recoverable.
export async function uploadEncryptedRecoveryArtifact(
    key: string,
    buffer: Buffer,
): Promise<void> {
    const { client, bucket } = bindingFor('primary');
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/gzip',
        ContentLength: buffer.length,
        ServerSideEncryption: 'AES256',
    }));
}

export async function recoveryArtifactEncryptionVerified(key: string): Promise<boolean> {
    const { client, bucket } = bindingFor('primary');
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ServerSideEncryption === 'AES256' || head.ServerSideEncryption === 'aws:kms';
}

// Recovery artifacts are private system objects. Callers never receive a
// public URL; CMS records only the opaque key/checksum in its ledger.
export async function readObjectBuffer(key: string, maxBytes: number, tier: StorageTier = 'primary'): Promise<Buffer> {
    const { client, bucket } = bindingFor(tier);
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) throw new Error('storage object has no body');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('storage object exceeds recovery artifact limit');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
}

/**
 * Upload a stream directly into S3. Used by moveObjectBetweenTiers so we don't
 * have to spool to disk first.
 */
export async function uploadStream(
    key: string,
    body: NodeJS.ReadableStream,
    size: number,
    contentType: string,
    tier: StorageTier = 'primary'
): Promise<string> {
    const { client, bucket } = bindingFor(tier);
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body as PutObjectCommandInput['Body'],
        ContentType: contentType,
        ContentLength: size,
    }));
    return getPublicUrl(key, tier);
}

/**
 * List every object in the bucket and yield them in pages.
 */
export async function* listAllObjects(
    prefix?: string,
    tier: StorageTier = 'primary'
): AsyncGenerator<S3Object[]> {
    const { client, bucket } = bindingFor(tier);
    let continuationToken: string | undefined;
    do {
        const resp = await client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
                MaxKeys: 1000,
            })
        );
        if (resp.Contents && resp.Contents.length > 0) {
            yield resp.Contents;
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
}

export interface StorageUsage {
    usedBytes: number;
    objectCount: number;
    byArtifactType: Record<string, number>;
}

/**
 * Compute live bucket usage by paginating through ListObjectsV2.
 */
export async function computeStorageUsage(tier: StorageTier = 'primary'): Promise<StorageUsage> {
    let usedBytes = 0;
    let objectCount = 0;
    const byArtifactType: Record<string, number> = {};

    for await (const page of listAllObjects(undefined, tier)) {
        for (const obj of page) {
            const size = obj.Size ?? 0;
            usedBytes += size;
            objectCount += 1;

            const key = obj.Key ?? '';
            const parts = key.split('/');
            let group = 'other';
            if (parts.length >= 3 && parts[0] === 'content') {
                const filename = parts[parts.length - 1];
                const dot = filename.lastIndexOf('.');
                group = artifactFamilyForKey(key) ?? (dot > 0 ? filename.slice(0, dot) : filename);
            }
            byArtifactType[group] = (byArtifactType[group] ?? 0) + size;
        }
    }

    return { usedBytes, objectCount, byArtifactType };
}

/**
 * List all keys for a specific content item id.
 */
export async function listContentObjects(
    contentItemId: string,
    tier: StorageTier = 'primary'
): Promise<S3Object[]> {
    const prefix = `content/${contentItemId}/`;
    const out: S3Object[] = [];
    for await (const page of listAllObjects(prefix, tier)) {
        out.push(...page);
    }
    return out;
}

/**
 * Delete a single object. Returns the freed bytes (best-effort via HEAD).
 */
export async function deleteObject(key: string, tier: StorageTier = 'primary'): Promise<number> {
    const { client, bucket } = bindingFor(tier);
    let size = 0;
    try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        size = head.ContentLength ?? 0;
    } catch {
        // Object may already be missing — fall through and try delete anyway
    }
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return size;
}

/**
 * Delete a batch of keys (max 1000 per S3 call). Returns freed bytes total
 * and any per-key errors.
 */
export async function deleteObjectsByKeys(
    keys: string[],
    tier: StorageTier = 'primary'
): Promise<{
    deletedCount: number;
    freedBytes: number;
    errors: string[];
}> {
    if (keys.length === 0) {
        return { deletedCount: 0, freedBytes: 0, errors: [] };
    }

    const { client, bucket } = bindingFor(tier);
    let deletedCount = 0;
    let freedBytes = 0;
    const errors: string[] = [];

    const sizeMap = new Map<string, number>();
    await Promise.all(
        keys.map(async key => {
            try {
                const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
                sizeMap.set(key, head.ContentLength ?? 0);
            } catch {
                // ignore — object may not exist
            }
        })
    );

    for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const objects: ObjectIdentifier[] = batch.map(Key => ({ Key }));
        try {
            const resp = await client.send(
                new DeleteObjectsCommand({
                    Bucket: bucket,
                    Delete: { Objects: objects, Quiet: false },
                })
            );
            for (const deleted of resp.Deleted ?? []) {
                if (deleted.Key) {
                    deletedCount += 1;
                    freedBytes += sizeMap.get(deleted.Key) ?? 0;
                }
            }
            for (const err of resp.Errors ?? []) {
                errors.push(`${err.Key}: ${err.Message}`);
            }
        } catch (err) {
            errors.push(`batch ${i / 1000}: ${(err as Error).message}`);
        }
    }

    return { deletedCount, freedBytes, errors };
}

/**
 * Delete every artifact for a single content item.
 */
export async function deleteContentObjects(
    contentItemId: string,
    artifacts?: string[],
    tier: StorageTier = 'primary'
): Promise<{ deletedCount: number; freedBytes: number; errors: string[]; objectsAbsent: boolean }> {
    const all = await listContentObjects(contentItemId, tier);
    let keys = all.map(o => o.Key!).filter(Boolean);
    if (artifacts && artifacts.length > 0) {
        const setLike = new Set(artifacts);
        keys = keys.filter(key => matchesArtifactFamily(key, setLike));
    }
    const result = await deleteObjectsByKeys(keys, tier);
    let objectsAbsent = false;
    if (result.errors.length === 0) {
        try {
            const remaining = await listContentObjects(contentItemId, tier);
            objectsAbsent = remaining.length === 0;
            const selectedRemaining = artifacts && artifacts.length > 0
                ? remaining.map(object => object.Key ?? '').filter(Boolean).filter(key => matchesArtifactFamily(key, new Set(artifacts)))
                : remaining.map(object => object.Key ?? '').filter(Boolean);
            if (selectedRemaining.length > 0) {
                result.errors.push('provider readback found remaining content objects');
            }
        } catch (error) {
            result.errors.push(`provider deletion readback failed: ${(error as Error).message}`);
        }
    }
    return { ...result, objectsAbsent };
}

/** Classify canonical, versioned, HLS, and repair artifacts by lifecycle family. */
export function artifactFamilyForKey(key: string): 'processed' | 'original' | 'thumbnail' | undefined {
    const relative = key.split('/').slice(2).join('/');
    const root = relative.split('/')[0] ?? '';
    const filename = relative.split('/').pop() ?? '';
    if (root === 'hls') return 'processed';
    for (const artifact of ['processed', 'original', 'thumbnail'] as const) {
        if (
            root === artifact || root.startsWith(`${artifact}.`) || root.startsWith(`${artifact}_`) ||
            filename === artifact || filename.startsWith(`${artifact}.`) || filename.startsWith(`${artifact}_`)
        ) return artifact;
    }
    return undefined;
}

/** Match an artifact root and all deterministic version/HLS/repair children. */
export function matchesArtifactFamily(key: string, artifacts: Set<string>): boolean {
    const family = artifactFamilyForKey(key);
    return family !== undefined && artifacts.has(family);
}

/**
 * Delete only the provider objects frozen by a recovery saga. A URL reference
 * may be either the configured public URL or the canonical storage key.
 * Readback is strict: any unlisted object left under the content prefix makes
 * the operation fail closed instead of allowing CMS metadata deletion.
 */
export async function deleteContentObjectsExact(
    contentItemId: string,
    references: string[],
    tier: StorageTier = 'primary'
): Promise<{ deletedCount: number; freedBytes: number; errors: string[]; objectsAbsent: boolean }> {
    const all = await listContentObjects(contentItemId, tier);
    const normalized = new Set(references.map(value => String(value).trim()).filter(Boolean));
    const keys = all.map(object => object.Key ?? '').filter(Boolean);
    const matched = keys.filter(key => normalized.has(key) || normalized.has(getPublicUrl(key, tier)));
    const missing = [...normalized].filter(reference => !matched.some(key => key === reference || getPublicUrl(key, tier) === reference));
    const result = await deleteObjectsByKeys(matched, tier);
    let objectsAbsent = false;
    if (result.errors.length === 0) {
        try {
            const remaining = await listContentObjects(contentItemId, tier);
            objectsAbsent = remaining.length === 0;
            if (!objectsAbsent) result.errors.push('provider readback found unlisted content objects');
            // Missing frozen references are safe only when the complete
            // content prefix is already empty. That is the idempotent retry
            // case after a provider succeeded but the previous HTTP response
            // was lost; any remaining object keeps the saga blocked.
            if (missing.length > 0 && objectsAbsent === false) {
                result.errors.push(`recovery object map references missing provider objects: ${missing.join(',')}`);
            }
        } catch (error) {
            result.errors.push(`provider deletion readback failed: ${(error as Error).message}`);
        }
    }
    return { ...result, objectsAbsent };
}

// -----------------------------------------------------------------------------
// Tier-to-tier movement
// -----------------------------------------------------------------------------

export interface MoveResult {
    movedCount: number;
    bytesMoved: number;
    newPrimaryUrls: Record<string, string>; // artifactType -> new public URL on the cold tier
    errors: string[];
}

/**
 * Move every artifact for a content item from one tier to another by streaming
 * the bytes. Used for primary→cold during circulation, and cold→primary for
 * restore. Returns per-artifact public URLs on the destination tier.
 *
 * Strategy: list source keys, stream each from source S3 → destination S3,
 * verify, then delete from source.
 */
export async function moveObjectBetweenTiers(
    contentItemId: string,
    from: StorageTier,
    to: StorageTier,
    artifacts?: string[]
): Promise<MoveResult> {
    if (from === to) {
        throw new Error('moveObjectBetweenTiers: from and to tiers must differ');
    }
    if (to === 'cold' && !isColdTierConfigured()) {
        throw new Error('Cold tier is not configured — set COLD_STORAGE_* env vars');
    }

    const sourceObjs = await listContentObjects(contentItemId, from);
    let keys = sourceObjs.map(o => o.Key!).filter(Boolean);
    if (artifacts && artifacts.length > 0) {
        const setLike = new Set(artifacts);
        keys = keys.filter(key => matchesArtifactFamily(key, setLike));
    }

    const result: MoveResult = {
        movedCount: 0,
        bytesMoved: 0,
        newPrimaryUrls: {},
        errors: [],
    };

    for (const key of keys) {
        try {
            const src = await getObjectStream(key, from);
            await uploadStream(
                key,
                src.body,
                src.size,
                src.contentType ?? 'application/octet-stream',
                to
            );
            // Confirmed on destination — now safe to delete from source
            await deleteObject(key, from);
            result.movedCount += 1;
            result.bytesMoved += src.size;

            const file = key.split('/').pop() ?? '';
            const dot = file.lastIndexOf('.');
            const artifactType = dot > 0 ? file.slice(0, dot) : file;
            result.newPrimaryUrls[artifactType] = getPublicUrl(key, to);
        } catch (err) {
            result.errors.push(`${key}: ${(err as Error).message}`);
            logger.error('moveObjectBetweenTiers: failed for key', err, { key, from, to });
        }
    }

    return result;
}

export const storageClient = {
    getStorageKey,
    getPublicUrl,
    objectExists,
    getObjectSize,
    getObjectStream,
    uploadFile,
    uploadBuffer,
	uploadEncryptedRecoveryArtifact,
	recoveryArtifactEncryptionVerified,
	readObjectBuffer,
    uploadStream,
    listAllObjects,
    listContentObjects,
    computeStorageUsage,
    deleteObject,
    deleteObjectsByKeys,
    deleteContentObjects,
    deleteContentObjectsExact,
    moveObjectBetweenTiers,
    isColdTierConfigured,
    s3Client,
    primaryClient,
    coldClient,
};
