/**
 * Legacy aggregate retry is intentionally disabled by WP-09.
 *
 * A PENDING item without current per-stage evidence is unknown/manual
 * attention, not permission to manufacture a queue job.
 */
import { logger } from '../observability/logger.js';

logger.error('retry-pending is disabled: use a CMS-approved pipeline.resume_exact_stage action.');
process.exitCode = 2;
