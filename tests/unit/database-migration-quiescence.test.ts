import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  const pause = vi.fn().mockResolvedValue(undefined);
  const resume = vi.fn().mockResolvedValue(undefined);
  return {
    values,
    pause,
    resume,
    redis: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
    },
  };
});

vi.mock('../../src/queues/redis.js', () => ({
  getRedisConnection: () => mocks.redis,
}));

vi.mock('../../src/workers/index.js', () => ({
  getAllWorkers: () => [{ pause: mocks.pause, resume: mocks.resume }],
}));

vi.mock('../../src/queues/index.js', () => ({
  QUEUE_NAMES: { PODS_MEDIA: 'pods-media-queue' },
  getQueue: () => ({ getActiveCount: vi.fn().mockResolvedValue(0) }),
}));

describe('database migration quiescence', () => {
  beforeEach(() => {
    mocks.values.clear();
    vi.clearAllMocks();
  });

  it('persists its exact owner, restores the pause, and requires it to resume', async () => {
    const module = await import('../../src/services/database-migration-quiescence.js');
    const programId = '11111111-1111-4111-8111-111111111111';

    const quiesced = await module.quiesceForDatabaseMigration(programId, 9);
    expect(quiesced.state).toBe('quiesced');
    expect(mocks.values.size).toBe(1);
    expect(mocks.pause).toHaveBeenCalled();

    await expect(
      module.resumeAfterDatabaseMigration('22222222-2222-4222-8222-222222222222', 9),
    ).rejects.toThrow(/does not match/);

    const resumed = await module.resumeAfterDatabaseMigration(programId, 9);
    expect(resumed.state).toBe('not_quiesced');
    expect(mocks.values.size).toBe(0);
    expect(mocks.resume).toHaveBeenCalled();
  });
});
