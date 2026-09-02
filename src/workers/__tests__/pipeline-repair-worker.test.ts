import { pipelineRepairQueueJobId } from '../pipeline-repair.worker.js';

describe('pipeline repair queue identity', () => {
  it('is stable and avoids BullMQ reserved separators', () => {
    const cmsId = 'pipeline-repair:e331b33f09fa3bb9eaf7599956bd211c';
    const first = pipelineRepairQueueJobId(cmsId);
    expect(first).toBe(pipelineRepairQueueJobId(cmsId));
    expect(first).toMatch(/^pipeline-repair-[a-f0-9]{64}$/);
    expect(first).not.toContain(':');
  });

  it('does not collapse distinct CMS identities', () => {
    expect(pipelineRepairQueueJobId('pipeline-repair:a')).not.toBe(
      pipelineRepairQueueJobId('pipeline-repair:b'),
    );
  });
});
