import { beforeEach, describe, expect, it, vi } from "vitest";

type CapturedWorker = {
  queueName: string;
  processor: (
    job: { id?: string; data: unknown; log?: (message: string) => void },
    logger: TestLogger,
  ) => Promise<void>;
};

type TestLogger = {
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
  const capturedWorkers = new Map<string, CapturedWorker>();
  return {
    capturedWorkers,
    createWorker: vi.fn((config: CapturedWorker) => {
      capturedWorkers.set(config.queueName, config);
      return {
        name: config.queueName,
        close: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      };
    }),
    getQueue: vi.fn(),
    updateStatus: vi.fn(),
    updateArtifacts: vi.fn(),
    transitionArtifactManifest: vi.fn(),
    getContentItem: vi.fn(),
    reportSourceRun: vi.fn(),
    redundancyPrecheck: vi.fn(),
    downloadYouTube: vi.fn(),
    downloadHttp: vi.fn(),
    downloadTelegram: vi.fn(),
    cleanupTempFile: vi.fn(),
    isAllowedYouTubeUrl: vi.fn(),
    transcodeToMp4: vi.fn(),
    extractThumbnail: vi.fn(),
    getMediaInfo: vi.fn(),
    containerExtension: vi.fn(),
    containerMime: vi.fn(),
    uploadFile: vi.fn(),
    getAttemptStorageKey: vi.fn(),
    getStorageKey: vi.fn(),
    objectExists: vi.fn(),
    getPublicUrl: vi.fn(),
    resolveIngestProfile: vi.fn(),
    preflightCheck: vi.fn(),
    captionsToFullText: vi.fn(),
    normalizeItem: vi.fn(),
    checkDedup: vi.fn(),
    upsertContentItem: vi.fn(),
    reserveLocalScratch: vi.fn(),
    uploadFileWithManifest: vi.fn(),
    registerExistingObjectWithManifest: vi.fn(),
  };
});

vi.mock("../../src/workers/base-worker.js", () => ({
  createWorker: mocks.createWorker,
}));

vi.mock("../../src/queues/index.js", () => ({
  QUEUE_NAMES: {
    NORMALIZE: "normalize-queue",
    MEDIA: "media-queue",
    AI: "ai-queue",
  },
  getQueue: mocks.getQueue,
}));

vi.mock("../../src/cms/client.js", () => ({
  cmsClient: {
    updateStatus: mocks.updateStatus,
    updateArtifacts: mocks.updateArtifacts,
    transitionArtifactManifest: mocks.transitionArtifactManifest,
    getContentItem: mocks.getContentItem,
    reportSourceRun: mocks.reportSourceRun,
    redundancyPrecheck: mocks.redundancyPrecheck,
  },
}));

vi.mock("../../src/config/index.js", () => ({
  config: {
    mediaJobTimeoutMs: 1_800_000,
    mediaTempDir: "/tmp/wahb-media-test",
  },
}));

vi.mock("../../src/media/downloader.js", () => ({
  downloadYouTube: mocks.downloadYouTube,
  downloadHttp: mocks.downloadHttp,
  downloadTelegram: mocks.downloadTelegram,
  cleanupTempFile: mocks.cleanupTempFile,
  isAllowedYouTubeUrl: mocks.isAllowedYouTubeUrl,
}));

vi.mock("../../src/media/transcoder.js", () => ({
  transcodeToMp4: mocks.transcodeToMp4,
  extractThumbnail: mocks.extractThumbnail,
  getMediaInfo: mocks.getMediaInfo,
  containerExtension: mocks.containerExtension,
  containerMime: mocks.containerMime,
}));

vi.mock("../../src/storage/client.js", () => ({
  uploadFile: mocks.uploadFile,
  getAttemptStorageKey: mocks.getAttemptStorageKey,
  getStorageKey: mocks.getStorageKey,
  objectExists: mocks.objectExists,
  getPublicUrl: mocks.getPublicUrl,
}));

vi.mock("../../src/storage/manifest.js", () => ({
  uploadFileWithManifest: mocks.uploadFileWithManifest,
  registerExistingObjectWithManifest: mocks.registerExistingObjectWithManifest,
}));

vi.mock("../../src/runtime/local-reservations.js", () => ({
  reserveLocalScratch: mocks.reserveLocalScratch,
}));

vi.mock("../../src/runtime/resource-admission.js", () => ({
  ResourceDeferredError: class ResourceDeferredError extends Error {},
  mergeAbortSignals: (first?: AbortSignal, second?: AbortSignal) => second ?? first,
  withResourceLease: async (
    _workload: string,
    _lane: string,
    effect: () => Promise<unknown>,
  ) => effect(),
}));

vi.mock("../../src/services/quality.service.js", () => ({
  resolveIngestProfile: mocks.resolveIngestProfile,
  preflightCheck: mocks.preflightCheck,
}));

vi.mock("../../src/media/captions.js", () => ({
  captionsToFullText: mocks.captionsToFullText,
}));

vi.mock("../../src/normalizers/index.js", () => ({
  normalizeItem: mocks.normalizeItem,
}));

vi.mock("../../src/services/dedup.service.js", () => ({
  dedupService: {
    checkDedup: mocks.checkDedup,
  },
}));

vi.mock("../../src/cms/upsert.js", () => ({
  upsertContentItem: mocks.upsertContentItem,
}));

const { createLegacyMediaWorker } =
  await import("../../src/workers/media.worker.js");
createLegacyMediaWorker();
const { createNormalizeWorker } = await import("../../src/workers/normalize.worker.js");
createNormalizeWorker();

const mediaQueueName = "media-queue";
const normalizeQueueName = "normalize-queue";
const aiQueueName = "ai-queue";

function logger(): TestLogger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function mediaQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: "media-job-1" }),
    getJob: vi.fn().mockResolvedValue(null),
  };
}

function aiQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: "ai-job-1" }),
    getJob: vi.fn().mockResolvedValue(null),
  };
}

function baseNormalized(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "idem-1",
    type: "VIDEO",
    source: "YOUTUBE",
    status: "READY",
    title: "A substantial media title",
    bodyText:
      "Body text long enough to pass the default moderation content length check.".repeat(
        2,
      ),
    excerpt: "A useful excerpt",
    author: null,
    sourceName: "Source",
    sourceFeedUrl: "https://example.com/feed.xml",
    mediaUrl: null,
    thumbnailUrl: null,
    originalUrl: "https://youtube.com/watch?v=abc123",
    durationSec: 600,
    topicTags: [],
    metadata: {},
    publishedAt: null,
    ...overrides,
  };
}

describe("worker processor capture", () => {
  it("captures media and normalize workers without creating real BullMQ workers", () => {
    expect(mocks.createWorker).toHaveBeenCalled();
    expect(mocks.capturedWorkers.has(mediaQueueName)).toBe(true);
    expect(mocks.capturedWorkers.has(normalizeQueueName)).toBe(true);
  });
});

describe("media worker characterization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStorageKey.mockImplementation(
      (contentItemId: string, artifactType: string, extension: string) =>
        `content/${contentItemId}/${artifactType}.${extension}`,
    );
    mocks.getAttemptStorageKey.mockImplementation(
      (
        contentItemId: string,
        attemptId: string,
        artifactType: string,
        extension: string,
      ) =>
        `content/${contentItemId}/attempts/${attemptId}/${artifactType}.${extension}`,
    );
    mocks.getPublicUrl.mockImplementation(
      (key: string) => `https://storage.example.com/${key}`,
    );
    mocks.objectExists.mockResolvedValue(true);
    mocks.updateStatus.mockResolvedValue(undefined);
    mocks.updateArtifacts.mockResolvedValue(undefined);
    mocks.transitionArtifactManifest.mockResolvedValue(undefined);
    mocks.getContentItem.mockResolvedValue({
      tenant_id: "default",
      duration_sec: 600,
      metadata: {
        duration_verification: { source: "ffprobe", duration_sec: 600 },
      },
    });
    mocks.getMediaInfo.mockResolvedValue({
      hasAudio: true,
      hasVideo: true,
      duration: 600,
    });
    mocks.containerMime.mockReturnValue("video/mp4");
    mocks.reserveLocalScratch.mockResolvedValue({
      sourceDir: "/tmp/wahb-media-test/source",
      outputDir: "/tmp/wahb-media-test/output",
      hlsDir: "/tmp/wahb-media-test/hls",
      metadataDir: "/tmp/wahb-media-test/metadata",
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    });
    mocks.registerExistingObjectWithManifest.mockResolvedValue({
      url: "https://storage.example.com/content/content-1/processed.mp4",
      manifestId: "manifest-1",
      bytes: 100,
    });
  });

  it("repairs CMS artifacts and queues AI when the processed object already exists", async () => {
    const ai = aiQueue();
    mocks.getQueue.mockImplementation((name: string) =>
      name === aiQueueName ? ai : undefined,
    );
    const processor = mocks.capturedWorkers.get(mediaQueueName)?.processor;

    await processor!(
      {
        id: "media-job-1",
        log: vi.fn(),
        data: {
          contentItemId: "content-1",
          contentType: "VIDEO",
          sourceType: "YOUTUBE",
          sourceUrl: "https://youtube.com/watch?v=abc123",
          operations: ["download", "transcode", "thumbnail"],
          textContent: {
            title: "Video title",
            excerpt: "Video excerpt",
          },
        },
      },
      logger(),
    );

    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "content-1",
      { status: "PROCESSING" },
      "media-job-1",
      undefined,
    );
    expect(mocks.updateArtifacts).toHaveBeenCalledWith(
      "content-1",
      expect.objectContaining({
        media_url:
          "https://storage.example.com/content/content-1/attempts/media-job-1/processed.mp4",
        playback_url:
          "https://storage.example.com/content/content-1/attempts/media-job-1/processed.mp4",
        playback_type: "mp4",
        has_video: true,
      }),
      "media-job-1",
    );
    expect(ai.add).toHaveBeenCalledWith(
      "ai-VIDEO-content-1",
      expect.objectContaining({
        contentItemId: "content-1",
        contentType: "VIDEO",
        operations: ["transcript", "embedding"],
        mediaUrl:
          "https://storage.example.com/content/content-1/attempts/media-job-1/processed.mp4",
      }),
      { priority: 1, jobId: "ai-content-1" },
    );
    expect(mocks.downloadHttp).not.toHaveBeenCalled();
    expect(mocks.downloadYouTube).not.toHaveBeenCalled();
    expect(mocks.downloadTelegram).not.toHaveBeenCalled();
    expect(mocks.transcodeToMp4).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("does not repair an existing Pods object whose duration was never verified", async () => {
    const ai = aiQueue();
    mocks.getQueue.mockImplementation((name: string) =>
      name === aiQueueName ? ai : undefined,
    );
    mocks.getContentItem.mockResolvedValue({
      tenant_id: "default",
      duration_sec: null,
    });
    const processor = mocks.capturedWorkers.get(mediaQueueName)?.processor;

    await processor!(
      {
        id: "media-job-unverified",
        log: vi.fn(),
        data: {
          contentItemId: "content-unverified",
          contentType: "VIDEO",
          sourceType: "YOUTUBE",
          sourceUrl: "https://youtube.com/watch?v=unverified",
          operations: ["download", "transcode", "thumbnail"],
          textContent: { title: "Unverified video" },
        },
      },
      logger(),
    );

    expect(mocks.updateArtifacts).not.toHaveBeenCalled();
    expect(ai.add).not.toHaveBeenCalled();
    expect(mocks.updateStatus).toHaveBeenLastCalledWith(
      "content-unverified",
      {
        status: "FAILED",
        failure_reason: "media_artifact_duration_unverified",
      },
      "media-job-unverified",
      undefined,
    );
  });

  it("does not enqueue duplicate AI work when an AI job is already active", async () => {
    const ai = aiQueue();
    ai.getJob.mockResolvedValue({
      id: "ai-content-1",
      getState: vi.fn().mockResolvedValue("active"),
      remove: vi.fn(),
    });
    mocks.getQueue.mockImplementation((name: string) =>
      name === aiQueueName ? ai : undefined,
    );
    const processor = mocks.capturedWorkers.get(mediaQueueName)?.processor;

    await processor!(
      {
        id: "media-job-1",
        log: vi.fn(),
        data: {
          contentItemId: "content-1",
          contentType: "VIDEO",
          sourceType: "YOUTUBE",
          sourceUrl: "https://youtube.com/watch?v=abc123",
          operations: ["download", "transcode", "thumbnail"],
          textContent: {
            title: "Video title",
            excerpt: "Video excerpt",
          },
        },
      },
      logger(),
    );

    expect(ai.add).not.toHaveBeenCalled();
  });
});

describe("normalize worker characterization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkDedup.mockResolvedValue({ isDuplicate: false });
    mocks.redundancyPrecheck.mockResolvedValue({
      candidates: [{ verdict: "clear", confidence: 1, reasons: [] }],
    });
    mocks.upsertContentItem.mockResolvedValue({
      contentItemId: "content-1",
      created: true,
    });
    mocks.reportSourceRun.mockResolvedValue(undefined);
  });

  it("routes video content to the media queue", async () => {
    const media = mediaQueue();
    const ai = aiQueue();
    mocks.getQueue.mockImplementation((name: string) => {
      if (name === mediaQueueName) return media;
      if (name === aiQueueName) return ai;
      return undefined;
    });
    mocks.normalizeItem.mockReturnValue(baseNormalized());
    const processor = mocks.capturedWorkers.get(normalizeQueueName)?.processor;

    await processor!(
      {
        id: "normalize-job-1",
        data: {
          sourceId: "source-1",
          sourceType: "YOUTUBE",
          rawItems: [
            {
              externalId: "raw-1",
              rawData: { externalId: "raw-1", metadata: {} },
              fetchedAt: "2026-07-08T00:00:00.000Z",
            },
          ],
          fetchJobId: "fetch-job-1",
          triggeredBy: "manual",
          sourceSettings: {},
        },
      },
      logger(),
    );

    expect(media.add).toHaveBeenCalledWith(
      "media-VIDEO-content-1",
      expect.objectContaining({
        contentItemId: "content-1",
        contentType: "VIDEO",
        sourceType: "YOUTUBE",
        sourceUrl: "https://youtube.com/watch?v=abc123",
        operations: ["download", "transcode", "thumbnail"],
      }),
      { priority: 2, jobId: "media-content-1" },
    );
    expect(ai.add).not.toHaveBeenCalled();
  });

  it("does not enqueue duplicate media work when a media job is already active", async () => {
    const media = mediaQueue();
    const ai = aiQueue();
    media.getJob.mockResolvedValue({
      id: "media-content-1",
      getState: vi.fn().mockResolvedValue("active"),
      remove: vi.fn(),
    });
    mocks.getQueue.mockImplementation((name: string) => {
      if (name === mediaQueueName) return media;
      if (name === aiQueueName) return ai;
      return undefined;
    });
    mocks.normalizeItem.mockReturnValue(baseNormalized());
    const processor = mocks.capturedWorkers.get(normalizeQueueName)?.processor;

    await processor!(
      {
        id: "normalize-job-1",
        data: {
          sourceId: "source-1",
          sourceType: "YOUTUBE",
          rawItems: [
            {
              externalId: "raw-1",
              rawData: { externalId: "raw-1", metadata: {} },
              fetchedAt: "2026-07-08T00:00:00.000Z",
            },
          ],
          fetchJobId: "fetch-job-1",
          triggeredBy: "manual",
          sourceSettings: {},
        },
      },
      logger(),
    );

    expect(media.add).not.toHaveBeenCalled();
    expect(ai.add).not.toHaveBeenCalled();
  });

  it("routes Telegram text articles to embedding-only AI with the deterministic job id", async () => {
    const media = mediaQueue();
    const ai = aiQueue();
    mocks.getQueue.mockImplementation((name: string) => {
      if (name === mediaQueueName) return media;
      if (name === aiQueueName) return ai;
      return undefined;
    });
    mocks.normalizeItem.mockReturnValue(
      baseNormalized({
        type: "ARTICLE",
        source: "TELEGRAM",
        originalUrl: "https://t.me/example/1",
        metadata: { mediaKind: "text" },
      }),
    );
    const processor = mocks.capturedWorkers.get(normalizeQueueName)?.processor;

    await processor!(
      {
        id: "normalize-job-1",
        data: {
          sourceId: "source-1",
          sourceType: "TELEGRAM",
          rawItems: [
            {
              externalId: "raw-1",
              rawData: { externalId: "raw-1", metadata: {} },
              fetchedAt: "2026-07-08T00:00:00.000Z",
            },
          ],
          fetchJobId: "fetch-job-1",
          triggeredBy: "manual",
          sourceSettings: {},
        },
      },
      logger(),
    );

    expect(media.add).not.toHaveBeenCalled();
    expect(ai.add).toHaveBeenCalledWith(
      "ai-text-article-content-1",
      expect.objectContaining({
        contentItemId: "content-1",
        contentType: "ARTICLE",
        operations: ["embedding"],
      }),
      { priority: 2, jobId: "ai-content-1" },
    );
  });

  it("does not enqueue media or AI for archived items", async () => {
    const media = mediaQueue();
    const ai = aiQueue();
    mocks.getQueue.mockImplementation((name: string) => {
      if (name === mediaQueueName) return media;
      if (name === aiQueueName) return ai;
      return undefined;
    });
    mocks.normalizeItem.mockReturnValue(
      baseNormalized({
        status: "ARCHIVED",
        metadata: { moderation: { decision: "auto_rejected" } },
      }),
    );
    const processor = mocks.capturedWorkers.get(normalizeQueueName)?.processor;

    await processor!(
      {
        id: "normalize-job-1",
        data: {
          sourceId: "source-1",
          sourceType: "YOUTUBE",
          rawItems: [
            {
              externalId: "raw-1",
              rawData: { externalId: "raw-1", metadata: {} },
              fetchedAt: "2026-07-08T00:00:00.000Z",
            },
          ],
          fetchJobId: "fetch-job-1",
          triggeredBy: "manual",
          sourceSettings: {},
        },
      },
      logger(),
    );

    expect(media.add).not.toHaveBeenCalled();
    expect(ai.add).not.toHaveBeenCalled();
  });
});
