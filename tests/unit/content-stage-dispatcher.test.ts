import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deferContentStage } = vi.hoisted(() => ({ deferContentStage: vi.fn() }));
vi.mock('../../src/cms/client.js', () => ({
  cmsClient: { deferContentStage },
}));

import { deliverContentStageClaim, queueNameForStage } from '../../src/services/content-stage-dispatcher.js';

const claim = (token: string) => ({
  stage: 'news_text_embedding',
  deterministic_job_id: 'stage:request:1',
  claim_token: token,
}) as never;

beforeEach(() => deferContentStage.mockReset());

describe('content-stage dispatcher ownership', () => {
  it.each([
    ['news_text_embedding', 'NEWS_ENRICHMENT'],
    ['news_llm_metadata', 'NEWS_OPTIONAL'],
    ['pods_media_artifacts', 'PODS_MEDIA'],
    ['pods_text_embedding', 'PODS_COMPLETION'],
    ['pods_caption_reembedding', 'PODS_OPTIONAL'],
    ['pods_llm_metadata', 'PODS_OPTIONAL'],
    ['pods_atomization', 'PODS_ATOMIZATION'],
  ])('%s is routed to %s', (stage, queue) => {
    expect(queueNameForStage(stage as never)).toBe(queue);
  });

  it('does not claim CMS-local or Media-owned stages', () => {
    expect(queueNameForStage('news_story_classification' as never)).toBeUndefined();
    expect(queueNameForStage('pods_transcript' as never)).toBeUndefined();
    expect(queueNameForStage('pods_image_embedding' as never)).toBeUndefined();
  });

  it('replaces a stale queued claim envelope before acknowledging delivery', async () => {
    const updateData = vi.fn();
    const queue = {
      getJob: vi.fn().mockResolvedValue({
        getState: vi.fn().mockResolvedValue('waiting'),
        updateData,
      }),
      add: vi.fn(),
    };

    await expect(deliverContentStageClaim(queue as never, claim('current'))).resolves.toBe(true);
    expect(updateData).toHaveBeenCalledWith({ claim: expect.objectContaining({ claim_token: 'current' }) });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('defers a reclaimed claim while an older deterministic delivery is active', async () => {
    const queue = {
      getJob: vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue('active') }),
    };

    await expect(deliverContentStageClaim(queue as never, claim('current'))).resolves.toBe(false);
    expect(deferContentStage).toHaveBeenCalledOnce();
  });
});
