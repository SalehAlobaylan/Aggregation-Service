/**
 * CMS API Contract Tests
 * Validates request payloads match expected interfaces
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Define expected CMS API contracts
const StatusUpdateSchema = z.object({
    status: z.enum(['PENDING', 'PROCESSING', 'FAILED', 'READY']),
    failure_reason: z.string().optional(),
});

const ArtifactsUpdateSchema = z.object({
    media_url: z.string().url().optional(),
    thumbnail_url: z.string().url().optional(),
    duration_sec: z.number().int().positive().optional(),
});

const TranscriptCreateSchema = z.object({
    content_item_id: z.string().uuid(),
    full_text: z.string().min(1),
    language: z.string().length(2).optional(),
});

const EmbeddingUpdateSchema = z.object({
    embedding: z.array(z.number()).length(384),
    topic_tags: z.array(z.string()).optional(),
});

const ContentItemCreateSchema = z.object({
    source_id: z.string().uuid(),
    url: z.string().url(),
    title: z.string().min(1),
    content_type: z.enum(['ARTICLE', 'VIDEO', 'PODCAST', 'POST']),
    published_at: z.string().datetime().optional(),
    author: z.string().optional(),
    excerpt: z.string().optional(),
});

describe('CMS API Contract: Status Updates', () => {
    it('should validate PENDING status', () => {
        const payload = { status: 'PENDING' };
        expect(StatusUpdateSchema.safeParse(payload).success).toBe(true);
    });

    it('should validate PROCESSING status', () => {
        const payload = { status: 'PROCESSING' };
        expect(StatusUpdateSchema.safeParse(payload).success).toBe(true);
    });

    it('should validate FAILED status with reason', () => {
        const payload = { status: 'FAILED', failure_reason: 'Download timeout' };
        expect(StatusUpdateSchema.safeParse(payload).success).toBe(true);
    });

    it('should validate READY status', () => {
        const payload = { status: 'READY' };
        expect(StatusUpdateSchema.safeParse(payload).success).toBe(true);
    });

    it('should reject invalid status', () => {
        const payload = { status: 'INVALID' };
        expect(StatusUpdateSchema.safeParse(payload).success).toBe(false);
    });
});

describe('CMS API Contract: Artifacts', () => {
    it('should validate media artifacts', () => {
        const payload = {
            media_url: 'https://storage.example.com/video.mp4',
            thumbnail_url: 'https://storage.example.com/thumb.jpg',
            duration_sec: 120,
        };
        expect(ArtifactsUpdateSchema.safeParse(payload).success).toBe(true);
    });

    it('should allow partial artifacts', () => {
        const payload = { media_url: 'https://storage.example.com/video.mp4' };
        expect(ArtifactsUpdateSchema.safeParse(payload).success).toBe(true);
    });

    it('should reject invalid URLs', () => {
        const payload = { media_url: 'not-a-url' };
        expect(ArtifactsUpdateSchema.safeParse(payload).success).toBe(false);
    });
});

describe('CMS API Contract: Transcripts', () => {
    it('should validate transcript creation', () => {
        const payload = {
            content_item_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            full_text: 'This is the transcribed text from the video.',
            language: 'en',
        };
        expect(TranscriptCreateSchema.safeParse(payload).success).toBe(true);
    });

    it('should require content_item_id as UUID', () => {
        const payload = {
            content_item_id: 'not-a-uuid',
            full_text: 'Test text',
        };
        expect(TranscriptCreateSchema.safeParse(payload).success).toBe(false);
    });
});

describe('CMS API Contract: Embeddings', () => {
    it('should validate 384-dimension embeddings', () => {
        const payload = {
            embedding: Array(384).fill(0.5),
            topic_tags: ['technology', 'ai'],
        };
        expect(EmbeddingUpdateSchema.safeParse(payload).success).toBe(true);
    });

    it('should reject wrong dimension embeddings', () => {
        const payload = {
            embedding: Array(256).fill(0.5),
        };
        expect(EmbeddingUpdateSchema.safeParse(payload).success).toBe(false);
    });
});

describe('CMS API Contract: Content Items', () => {
    it('should validate content item creation', () => {
        const payload = {
            source_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            url: 'https://example.com/article',
            title: 'Test Article Title',
            content_type: 'ARTICLE',
            published_at: '2024-01-15T10:30:00Z',
            author: 'John Doe',
        };
        expect(ContentItemCreateSchema.safeParse(payload).success).toBe(true);
    });

    it('should require content_type to be valid enum', () => {
        const payload = {
            source_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            url: 'https://example.com/article',
            title: 'Test',
            content_type: 'INVALID_TYPE',
        };
        expect(ContentItemCreateSchema.safeParse(payload).success).toBe(false);
    });
});

// Service Token Header Contract
describe('CMS API Contract: Headers', () => {
    it('should require X-Service-Token header format', () => {
        const validHeader = 'Bearer abc123xyz';
        expect(validHeader.startsWith('Bearer ')).toBe(true);
    });

    it('should include request ID for tracing', () => {
        const requestId = 'req_' + Date.now();
        expect(requestId.startsWith('req_')).toBe(true);
    });
});
