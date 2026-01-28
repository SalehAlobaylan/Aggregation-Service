/**
 * S3-Compatible Storage Client
 * Supports MinIO (dev) and Supabase Storage (prod)
 */
import {
    S3Client,
    PutObjectCommand,
    HeadObjectCommand,
    type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { lookup } from 'mime-types';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';

// Initialize S3 client
const s3Client = new S3Client({
    endpoint: config.storageEndpoint,
    region: config.storageRegion,
    credentials: {
        accessKeyId: config.storageAccessKey,
        secretAccessKey: config.storageSecretKey,
    },
    forcePathStyle: true, // Required for MinIO
});

/**
 * Generate deterministic storage key for content artifacts
 */
export function getStorageKey(
    contentItemId: string,
    artifactType: 'original' | 'processed' | 'thumbnail' | 'audio' | 'hls',
    extension: string
): string {
    return `content/${contentItemId}/${artifactType}.${extension}`;
}

/**
 * Get public URL for a storage key
 */
export function getPublicUrl(key: string): string {
    return `${config.storagePublicUrl}/${config.storageBucket}/${key}`;
}

/**
 * Check if an object exists in storage
 */
export async function objectExists(key: string): Promise<boolean> {
    try {
        await s3Client.send(
            new HeadObjectCommand({
                Bucket: config.storageBucket,
                Key: key,
            })
        );
        return true;
    } catch (error) {
        if ((error as { name?: string }).name === 'NotFound') {
            return false;
        }
        throw error;
    }
}

/**
 * Upload a file to storage with retry logic
 */
export async function uploadFile(
    key: string,
    filePath: string,
    contentType?: string
): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const fileStats = await stat(filePath);
            const fileStream = createReadStream(filePath);

            // Detect content type if not provided
            const mimeType = contentType || lookup(filePath) || 'application/octet-stream';

            const params: PutObjectCommandInput = {
                Bucket: config.storageBucket,
                Key: key,
                Body: fileStream,
                ContentType: mimeType,
                ContentLength: fileStats.size,
            };

            await s3Client.send(new PutObjectCommand(params));

            const publicUrl = getPublicUrl(key);

            logger.info('File uploaded to storage', {
                key,
                size: fileStats.size,
                contentType: mimeType,
                url: publicUrl,
            });

            return publicUrl;
        } catch (error) {
            lastError = error as Error;
            logger.warn(`Upload attempt ${attempt} failed`, {
                key,
                error: lastError.message,
            });

            if (attempt < maxRetries) {
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
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
    contentType: string
): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const params: PutObjectCommandInput = {
                Bucket: config.storageBucket,
                Key: key,
                Body: buffer,
                ContentType: contentType,
                ContentLength: buffer.length,
            };

            await s3Client.send(new PutObjectCommand(params));

            const publicUrl = getPublicUrl(key);

            logger.info('Buffer uploaded to storage', {
                key,
                size: buffer.length,
                contentType,
                url: publicUrl,
            });

            return publicUrl;
        } catch (error) {
            lastError = error as Error;
            logger.warn(`Upload attempt ${attempt} failed`, {
                key,
                error: lastError.message,
            });

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }

    throw lastError || new Error('Upload failed after retries');
}

export const storageClient = {
    getStorageKey,
    getPublicUrl,
    objectExists,
    uploadFile,
    uploadBuffer,
    s3Client,
};
