import { describe, expect, it, vi } from "vitest";
import { startContentStageLeaseHeartbeat, startContentStageLeaseHeartbeats } from "../../src/workers/content-stage-lease.js";

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
      safetyMarginMs: 60_000,
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

  it("aborts at the safety deadline even while a renewal is hung", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
    let finish!: (value: { lease_expires_at: string }) => void;
    const heartbeat = vi.fn(() => new Promise<{ lease_expires_at: string }>((resolve) => { finish = resolve; }));
    const controller = startContentStageLeaseHeartbeat({
      initialLeaseExpiresAt: "2026-09-08T00:02:00Z", heartbeat,
    });
    try {
      await vi.advanceTimersByTimeAsync(105_000);
      expect(heartbeat).toHaveBeenCalledOnce();
      expect(controller.signal.aborted).toBe(true);
    } finally {
      finish({ lease_expires_at: "2026-09-08T00:04:00Z" });
      await controller.stop();
      vi.useRealTimers();
    }
  });

  it("renews parent and unit leases through one serialized controller", async () => {
    const clock = controlledWait();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const controller = startContentStageLeaseHeartbeats({
      leases: [
        {
          name: "parent",
          initialLeaseExpiresAt: "2026-09-08T00:05:00Z",
          heartbeat: async () => {
            order.push("parent");
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight--;
            return { lease_expires_at: "2026-09-08T00:06:00Z" };
          },
        },
        {
          name: "unit",
          initialLeaseExpiresAt: "2026-09-08T00:04:00Z",
          heartbeat: async () => {
            order.push("unit");
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight--;
            return { lease_expires_at: "2026-09-08T00:07:00Z" };
          },
        },
      ],
      now: () => Date.parse("2026-09-08T00:00:00Z"),
      wait: clock.wait,
    });

    await clock.tick();
    await clock.tick();
    expect(order).toEqual(["parent", "unit", "parent", "unit"]);
    expect(maxInFlight).toBe(1);
    expect(controller.leaseExpiresAt()).toBe("2026-09-08T00:06:00.000Z");
    controller.removeLease("unit");
    expect(controller.leaseExpiresAt()).toBe("2026-09-08T00:06:00.000Z");
    await controller.stop();
  });
});
