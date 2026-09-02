import type { Job } from "bullmq";
import { createWorker } from "./base-worker.js";
import {
  getQueue,
  QUEUE_NAMES,
  type AtomizationJob,
  type ContentStageJob,
} from "../queues/index.js";
import { cmsClient } from "../cms/client.js";

/** The stage queue admits one attempt into the established cut executor. */
export const createPodsAtomizationStageWorker = () => createWorker({
  queueName: QUEUE_NAMES.PODS_ATOMIZATION,
  concurrency: 1,
  deadLetterQueueName: QUEUE_NAMES.PODS_STAGE_DLQ,
  processor: async (job: Job<ContentStageJob>, jobLogger): Promise<void> => {
    const { claim } = job.data;
    if (claim.lane !== "pods" || claim.stage !== "pods_atomization") {
      await cmsClient.deferContentStage(
        claim,
        1,
        "Wrong-lane delivery to Pods atomization worker",
        job.id,
      );
      return;
    }
    const queue = getQueue(QUEUE_NAMES.ATOMIZATION);
    if (!queue) {
      await cmsClient.deferContentStage(
        claim,
        5,
        "Atomization executor queue is unavailable",
        job.id,
      );
      return;
    }
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "prioritized",
    );
    if (
      counts.waiting + counts.active + counts.delayed + counts.prioritized >
      0
    ) {
      await cmsClient.deferContentStage(
        claim,
        5,
        "Atomization executor capacity is occupied",
        job.id,
      );
      return;
    }
    const downstreamID = `stage-atomization-${claim.request_id}-${claim.attempt_id}`;
    const existing = await queue.getJob(downstreamID);
    if (!existing) {
      const payload: AtomizationJob = {
        contentItemId: claim.content_item_id,
        reason: "transcript-ready",
        contentStageClaim: claim,
      };
      await queue.add("atomize-content-stage", payload, {
        jobId: downstreamID,
        attempts: 1,
      });
    }
    jobLogger.info("Atomization attempt handed to governed executor", {
      requestId: claim.request_id,
      attemptId: claim.attempt_id,
      downstreamID,
    });
  },
});
