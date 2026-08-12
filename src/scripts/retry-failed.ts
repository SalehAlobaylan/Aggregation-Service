/**
 * Legacy aggregate retry is intentionally disabled by WP-09.
 *
 * It used to reset FAILED rows and enqueue arbitrary jobs. Pipeline recovery
 * now requires a CMS-derived, tenant-scoped, approval-required exact stage.
 */
import { logger } from '../observability/logger.js';

logger.error('retry-failed is disabled: use a CMS-approved pipeline.resume_exact_stage action.');
process.exitCode = 2;
