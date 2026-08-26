import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/observability/logger.js";
import {
  abortActiveProcessors,
  runProcessorWithTimeout,
  workerTestUtils,
} from "../../src/workers/base-worker.js";

describe("worker timeout cancellation", () => {
  it("aborts the processor signal and waits for the processor to reject", async () => {
    let observedSignal: AbortSignal | undefined;
    const job = { id: "job-1", name: "test", data: {} } as unknown as Job;
    const jobLogger = createLogger({ queue: "test-queue", jobId: "job-1" });

    const run = runProcessorWithTimeout(
      async (_job, _logger, signal) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      job,
      jobLogger,
      { timeoutMs: 10, queueName: "test-queue", jobId: "job-1" },
    );

    await expect(run).rejects.toThrow(
      "Job timed out after 10ms in queue test-queue (jobId: job-1)",
    );
    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts active processor signals during worker shutdown", async () => {
    const job = {
      id: "job-shutdown",
      name: "test",
      data: {},
    } as unknown as Job;
    const jobLogger = createLogger({
      queue: "test-queue",
      jobId: "job-shutdown",
    });
    const shutdownReason = new Error("shutdown requested");

    const run = runProcessorWithTimeout(
      async (_job, _logger, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      job,
      jobLogger,
      { timeoutMs: 60_000, queueName: "test-queue", jobId: "job-shutdown" },
    );

    await Promise.resolve();
    expect(abortActiveProcessors(shutdownReason)).toBe(1);
    await expect(run).rejects.toBe(shutdownReason);
    expect(abortActiveProcessors()).toBe(0);
  });

  it("terminates the worker role when a processor ignores cancellation", async () => {
    const job = { id: "job-stuck", name: "test", data: {} } as unknown as Job;
    const jobLogger = createLogger({ queue: "test-queue", jobId: "job-stuck" });
    const roleExit = new Error("role termination requested");
    const restore = workerTestUtils.setRoleTerminator(() => {
      throw roleExit;
    });
    try {
      await expect(
        runProcessorWithTimeout(
          async () => new Promise<void>(() => {}),
          job,
          jobLogger,
          {
            timeoutMs: 5,
            cancellationGraceMs: 5,
            queueName: "test-queue",
            jobId: "job-stuck",
          },
        ),
      ).rejects.toBe(roleExit);
    } finally {
      restore();
    }
  });
});
