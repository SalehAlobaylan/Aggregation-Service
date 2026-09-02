import { describe, expect, it, vi } from "vitest";
import { startContentStageLeaseHeartbeat } from "../../src/workers/content-stage-lease.js";

function controlledWait() {
  const pending: Array<() => void> = [];
  return {
    wait: (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const done = () => resolve();
        pending.push(done);
        signal.addEventListener("abort", done, { once: true });
      }),
    tick: async () => {
      pending.shift()?.();
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    },
    release: () => pending.shift()?.(),
  };
}

describe("content-stage lease heartbeat", () => {
  it("serializes renewals and tracks the authoritative CMS expiration", async () => {
    const clock = controlledWait();
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const controller = startContentStageLeaseHeartbeat({
      initialLeaseExpiresAt: "2026-09-01T00:05:00.000Z",
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
      wait: clock.wait,
      heartbeat: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return { lease_expires_at: `2026-09-01T00:0${5 + calls}:00.000Z` };
      },
    });

    await clock.tick();
    await clock.tick();
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(controller.leaseExpiresAt()).toBe("2026-09-01T00:07:00.000Z");
    await controller.stop();
  });

  it("aborts effects before an unrenewed lease reaches its safety margin", async () => {
    const clock = controlledWait();
    const lost = vi.fn();
    const controller = startContentStageLeaseHeartbeat({
      initialLeaseExpiresAt: "2026-09-01T00:01:30.000Z",
      now: () => Date.parse("2026-09-01T00:00:40.000Z"),
      wait: clock.wait,
      heartbeat: async () => {
        throw new Error("CMS latency");
      },
      onLeaseLost: lost,
    });

    clock.release();
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    expect(lost).toHaveBeenCalledOnce();
    await controller.stop();
  });
});
