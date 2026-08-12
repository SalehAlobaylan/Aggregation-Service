import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('pipeline repair cutover', () => {
  it('does not leave legacy retry scripts with queue authority', () => {
    for (const file of ['src/scripts/retry-pending.ts', 'src/scripts/retry-failed.ts']) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source).toContain('disabled');
      expect(source).not.toContain('enqueueRetryJob');
      expect(source).not.toContain('updateStatus');
    }
  });

  it('runs the exact CMS-fenced stage directly rather than handing off to a broad worker', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/workers/pipeline-repair.worker.ts'), 'utf8');
    expect(source).toContain('claimPipelineRepair');
    expect(source).toContain('executePipelineRepairStage');
    expect(source).toContain('completePipelineRepair');
    expect(source).toContain("schemaVersion:'pipeline-repair/v1'");
    expect(source).not.toContain('enqueueRetryJob');
		expect(source).not.toContain('acknowledgePipelineRepair');
    expect(source).not.toContain('QUEUE_NAMES.MEDIA');
    expect(source).not.toContain('QUEUE_NAMES.AI');
    expect(source).toContain('existing.updateData(stage)');
    expect(source).toContain('same deterministic job');
  });

  it('keeps the normal media worker from treating a partial operation list as a full pipeline', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/workers/media.worker.ts'), 'utf8');
    expect(source).toContain('accepts only the canonical full ingest pipeline');
    expect(source).toContain("use pipeline-repair/v1 for an exact stage");
  });
});
