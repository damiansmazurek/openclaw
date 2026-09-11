import { describe, expect, it } from "vitest";
import { deliverOutboxItem } from "./adapters.js";
import { resolveIntakeLedgerConfig } from "./config.js";
import { createProductionDeliveryAdapters } from "./delivery.js";
import type { IntakeOutboxItem } from "./types.js";

function sampleItem(overrides: Partial<IntakeOutboxItem> = {}): IntakeOutboxItem {
  return {
    id: "outbox-1",
    kind: "reply_ack",
    status: "in_flight",
    attemptCount: 1,
    nextAttemptAtMs: 0,
    payload: {
      channel: "whatsapp",
      peerId: "mol-board@g.us",
      text: "extracted 1",
      boardId: "mol-board",
      intakeIdempotencyKey: "whatsapp:m1:0",
    },
    idempotencyKey: "reply_ack:env-1",
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe("intake production delivery", () => {
  it("sends reply acknowledgements through durable routing facts", async () => {
    const sends: Array<{ to: string; text: string }> = [];
    const adapters = createProductionDeliveryAdapters({
      config: resolveIntakeLedgerConfig({}),
      runtime: {
        sendBoardText: async ({ to, text }) => {
          sends.push({ to, text });
          return { messageId: "wa-1" };
        },
      },
    });
    const result = await deliverOutboxItem({
      item: sampleItem(),
      adapters,
    });
    expect(result).toEqual({ ok: true, remoteId: "wa-1" });
    expect(sends).toEqual([{ to: "mol-board@g.us", text: "extracted 1" }]);
  });

  it("fails missing Notion automation as a bounded configuration error", async () => {
    const adapters = createProductionDeliveryAdapters({
      config: resolveIntakeLedgerConfig({
        boards: [{ id: "mol-board", channel: "whatsapp" }],
      }),
    });
    const result = await deliverOutboxItem({
      item: sampleItem({ kind: "notion_create" }),
      adapters,
    });
    expect(result).toEqual({
      ok: false,
      error: "notion automation job is not configured for board mol-board",
      retryable: false,
    });
  });

  it("nudges the configured Gateway cron job and waits for claim/complete", async () => {
    const jobs: string[] = [];
    const adapters = createProductionDeliveryAdapters({
      config: resolveIntakeLedgerConfig({
        boards: [{ id: "mol-board", channel: "whatsapp", automationJobId: "notion-intake" }],
      }),
      runtime: {
        runCronJob: async (jobId) => {
          jobs.push(jobId);
          return { ran: true, runId: "run-9" };
        },
      },
    });
    const result = await deliverOutboxItem({
      item: sampleItem({ kind: "notion_create" }),
      adapters,
    });
    expect(jobs).toEqual(["notion-intake"]);
    expect(result).toMatchObject({ ok: false, awaitingExternal: true });
  });
});
