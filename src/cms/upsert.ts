/**
 * CMS Upsert Helper
 * Handles idempotent content item creation with CMS as the authority.
 */
import { cmsClient } from "./client.js";
import { dedupService } from "../services/dedup.service.js";
import { getRedisConnection } from "../queues/redis.js";
import { logger } from "../observability/logger.js";
import type { NormalizedItem } from "../normalizers/types.js";
import type { CreateContentItemRequest, ContentStatus } from "./types.js";

const SOURCE_CACHE_PREFIX = "source:";
const SOURCE_CACHE_TTL = 300; // 5 minutes

/**
 * Upsert a content item to CMS
 * - Checks Redis cache for existing content item ID
 * - Uses CMS POST which should be idempotent by idempotency_key
 * - Caches the mapping for future lookups
 */
export async function upsertContentItem(
  item: NormalizedItem,
  requestId?: string,
	lineage?: { tenantId: string; contentSourceId: string; sourceRunRequestId?: string; operatorPlanId?: string; operatorStepId?: string; idempotencyKey?: string },
): Promise<{
	contentItemId: string;
	created: boolean;
	retired: boolean;
	status: ContentStatus;
	disposition: "created" | "changed" | "no_change" | "retired" | "unknown";
	activeStages: string[];
	deliveryMode: "legacy" | "shadow" | "durable_required";
	nextRequiredStages: string[];
	lifecycleReconciliationRequired: boolean;
}> {
  const redis = getRedisConnection();
  const cacheKey = `${SOURCE_CACHE_PREFIX}${item.idempotencyKey}`;

  // Redis is an optimization only. Every observation reaches CMS so the
  // atomic manifest, generation, cutover, and lifecycle state are authoritative.

  // Build CMS request
  const request: CreateContentItemRequest = {
    idempotency_key: item.idempotencyKey,
    type: item.type,
    source: item.source,
    status: item.status,
    title: item.title,
    body_text: item.bodyText,
    excerpt: item.excerpt,
    content_language: item.contentLanguage,
    author: item.author,
    source_name: item.sourceName,
    source_feed_url: item.sourceFeedUrl,
		tenant_id: lineage?.tenantId,
		content_source_id: lineage?.contentSourceId,
		source_run_request_id: lineage?.sourceRunRequestId,
    media_url: item.mediaUrl,
    thumbnail_url: item.thumbnailUrl,
    original_url: item.originalUrl,
    duration_sec: item.durationSec,
    topic_tags: item.topicTags,
    metadata: item.metadata,
    published_at: item.publishedAt?.toISOString() ?? null,
    recovery_run_id: item.recovery?.runId,
    recovery_manifest_hash: item.recovery?.manifestHash,
  };

  try {
    // Create in CMS (should be idempotent)
    const response = await cmsClient.createContentItem(request, requestId);

    const contentItemId = response.id;
    const created = response.created !== false; // Assume created unless explicitly false
	const retired = response.retired === true;
	if (retired) {
		logger.info("Content ingest suppressed by Retention tombstone", {
			idempotencyKey: item.idempotencyKey,
			contentItemId,
		});
		return { contentItemId, created: false, retired: true, status: response.status, disposition: "retired", activeStages: [], deliveryMode: response.delivery_mode ?? "legacy", nextRequiredStages: [], lifecycleReconciliationRequired: false };
	}

    // Cache the mapping
    await redis.setex(cacheKey, SOURCE_CACHE_TTL, contentItemId);

    // Also mark as processed in dedup cache
    await dedupService.markProcessed(item.idempotencyKey, contentItemId);

    logger.info("Content item upserted", {
      contentItemId,
      idempotencyKey: item.idempotencyKey,
      type: item.type,
      source: item.source,
      status: item.status,
      created,
    });

    return {
		contentItemId,
		created,
		retired: false,
		status: response.status,
		disposition: response.disposition ?? "unknown",
		activeStages: response.active_stages ?? [],
		deliveryMode: response.delivery_mode ?? "legacy",
		nextRequiredStages: response.next_required_stages ?? [],
		lifecycleReconciliationRequired: response.lifecycle_reconciliation_required === true,
	};
  } catch (error) {
    // Check if it's a duplicate error (409 Conflict)
    if (error instanceof Error && error.message.includes("409")) {
      // Try to get existing ID from response or cache
      const existingId = await dedupService.getContentItemId(
        item.idempotencyKey,
      );
      if (existingId) {
        logger.debug("Content item already exists", {
          idempotencyKey: item.idempotencyKey,
          existingId,
        });
		// A cache hit cannot safely recover the missing CMS disposition. Let the
		// caller retry the authoritative idempotent request instead.
		throw error;
      }
    }

    logger.error("Failed to upsert content item", error, {
      idempotencyKey: item.idempotencyKey,
      type: item.type,
    });
    throw error;
  }
}

/**
 * Update content item status
 */
export async function updateContentStatus(
  contentItemId: string,
  status: ContentStatus,
  failureReason?: string,
  requestId?: string,
): Promise<void> {
  await cmsClient.updateStatus(
    contentItemId,
    { status, failure_reason: failureReason },
    requestId,
  );

  logger.info("Content status updated", { contentItemId, status });
}

export const cmsUpsert = {
  upsertContentItem,
  updateContentStatus,
};
