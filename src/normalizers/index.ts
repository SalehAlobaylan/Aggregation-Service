/**
 * Normalizer Router
 * Routes normalization requests to appropriate normalizer
 */
import { logger } from '../observability/logger.js';
import type { SourceType } from '../queues/schemas.js';
import type { RawFetchedItem } from '../fetchers/types.js';
import type { Normalizer, NormalizedItem, NormalizationResult } from './types.js';

import { articleNormalizer } from './article.normalizer.js';
import { videoNormalizer } from './video.normalizer.js';
import { podcastNormalizer } from './podcast.normalizer.js';
import { socialNormalizer } from './social.normalizer.js';
import { manualNormalizer } from './manual.normalizer.js';

// Register normalizers with their source types
const normalizersBySource: Map<SourceType, Normalizer> = new Map([
    ['RSS', articleNormalizer],
    ['YOUTUBE', videoNormalizer],
    ['PODCAST', podcastNormalizer],
    ['REDDIT', socialNormalizer],
    ['TWITTER', socialNormalizer],
    ['UPLOAD', manualNormalizer],
    ['MANUAL', manualNormalizer],
]);

/**
 * Get normalizer for a source type
 */
export function getNormalizer(sourceType: SourceType): Normalizer | undefined {
    return normalizersBySource.get(sourceType);
}

/**
 * Normalize a single item
 */
export function normalizeItem(item: RawFetchedItem): NormalizedItem | null {
    const normalizer = getNormalizer(item.sourceType);

    if (!normalizer) {
        logger.error('No normalizer available for source type', {
            sourceType: item.sourceType
        });
        return null;
    }

    try {
        return normalizer.normalize(item);
    } catch (error) {
        logger.error('Normalization failed', error, {
            sourceType: item.sourceType,
            externalId: item.externalId
        });
        return null;
    }
}

/**
 * Normalize a batch of items
 */
export function normalizeBatch(items: RawFetchedItem[]): NormalizationResult {
    const normalized: NormalizedItem[] = [];
    const errors: string[] = [];
    let skipped = 0;

    for (const item of items) {
        try {
            const result = normalizeItem(item);
            if (result) {
                normalized.push(result);
            } else {
                skipped++;
            }
        } catch (error) {
            errors.push(`${item.externalId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    logger.info('Batch normalization complete', {
        total: items.length,
        normalized: normalized.length,
        skipped,
        errors: errors.length,
    });

    return { normalized, skipped, errors };
}

// Re-export types
export * from './types.js';
