import { describe, expect, it } from "vitest";
import { createFailingAdapter, createRecordingAdapter } from "./adapters.js";
import { IntakeCompletenessError } from "./store.js";
import {
  createIntakeClock,
  createIntakeFixture,
  sampleSource,
  tenRequests,
} from "./test-harness.js";

describe("intake ledger required scenarios", () => {
  it("creates ten durable receipts before any canonical lookup", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource());
    let lookups = 0;
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: tenRequests(),
    });
    expect(lookups).toBe(0);
    expect(recorded.created).toBe(10);
    expect(recorded.envelope.extractedCount).toBe(10);
    expect(recorded.receipts.map((receipt) => receipt.requestIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    lookups += 1;
    expect(lookups).toBe(1);
    expect(() => service.closeTurn(envelope.id)).toThrow(IntakeCompletenessError);
  });

  it("reprocessing the same message creates no duplicate receipts or tasks", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "repeat-1" }));
    const first = service.recordRequests({ envelopeId: envelope.id, requests: tenRequests() });
    const replayedEnvelope = service.persistEnvelope(sampleSource({ messageId: "repeat-1" }));
    expect(replayedEnvelope.id).toBe(envelope.id);
    const second = service.recordRequests({ envelopeId: envelope.id, requests: tenRequests() });
    expect(second.created).toBe(0);
    expect(second.receipts.map((receipt) => receipt.id)).toEqual(
      first.receipts.map((receipt) => receipt.id),
    );
    for (const receipt of first.receipts) {
      service.recordDisposition({
        idempotencyKey: receipt.idempotencyKey,
        disposition: "created_new",
        canonicalTaskId: `task-${receipt.requestIndex}`,
      });
    }
    const replayed = service.recordDisposition({
      idempotencyKey: first.receipts[0]!.idempotencyKey,
      disposition: "created_new",
      canonicalTaskId: "task-0",
    });
    expect(replayed.replayed).toBe(true);
    expect(service.canonicalReady()).toHaveLength(10);
  });

  it("keeps an ambiguous canonical match visible and queued for review", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "ambiguous" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "NPC transcript single surface" }],
    });
    const result = service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 0,
      disposition: "needs_canonical_review",
      reason: "two existing NPC transcript tasks match",
      reviewOwner: "board",
      reviewDeadlineMs: Date.now() + 86_400_000,
    });
    expect(result.receipt.disposition).toBe("needs_canonical_review");
    const audit = service.audit();
    expect(audit.unresolved.some((entry) => entry.kind === "reviewable")).toBe(true);
    expect(service.canonicalReady()).toEqual([]);
  });

  it("recovers after a gateway interruption that happens after receipt and before Notion creation", async () => {
    const clock = createIntakeClock();
    const notion = createFailingAdapter({
      kind: "notion_create",
      error: "gateway interrupted",
      retryable: true,
    });
    const { service, store } = createIntakeFixture({
      now: clock.now,
      adapters: [notion, createRecordingAdapter({ kind: "reply_ack" })],
    });
    const envelope = service.persistEnvelope(sampleSource({ messageId: "interrupt" }));
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Fix fight narrator" }],
    });
    const pending = service.recordDisposition({
      idempotencyKey: recorded.receipts[0]!.idempotencyKey,
      disposition: "created_new",
    });
    expect(pending.pendingRemote).toBe(true);
    expect(pending.receipt.disposition).toBeUndefined();
    store.recoverStuckInFlight({ now: clock.now(), timeoutMs: 1 });
    clock.advance(1);
    const first = await service.reconcile();
    expect(first.retried + first.attempted + first.awaiting).toBeGreaterThan(0);
    expect(store.listUnresolved()[0]?.kind).not.toBe("pending_extraction");
    expect(
      store.getReceiptByIdempotencyKey(recorded.receipts[0]!.idempotencyKey)?.requestedDisposition,
    ).toBe("created_new");
    expect(
      store.getReceiptByIdempotencyKey(recorded.receipts[0]!.idempotencyKey)?.disposition,
    ).toBeUndefined();
  });

  it("does not silently lose a request during a Notion outage", async () => {
    const notion = createFailingAdapter({
      kind: "notion_create",
      error: "Notion 503",
      retryable: true,
    });
    const { service, store } = createIntakeFixture({
      adapters: [notion],
    });
    const envelope = service.persistEnvelope(sampleSource({ messageId: "notion-outage" }));
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Remove Strain" }],
    });
    service.recordDisposition({
      idempotencyKey: recorded.receipts[0]!.idempotencyKey,
      disposition: "created_new",
    });
    const result = await service.reconcile();
    expect(result.delivered).toBe(0);
    expect(result.retried + result.awaiting).toBeGreaterThan(0);
    expect(
      store.getReceiptByIdempotencyKey(recorded.receipts[0]!.idempotencyKey)?.requestText,
    ).toBe("Remove Strain");
    expect(store.listUnresolved().some((entry) => entry.kind === "undelivered_outbox")).toBe(true);
  });

  it("retries acknowledgement failure without losing dispositions", async () => {
    const ack = createFailingAdapter({
      kind: "reply_ack",
      error: "WhatsApp send failed",
      retryable: true,
    });
    const notion = createRecordingAdapter({ kind: "notion_create" });
    const { service, store } = createIntakeFixture({ adapters: [ack, notion] });
    const envelope = service.persistEnvelope(sampleSource({ messageId: "ack-fail" }));
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Shelf Start button" }],
    });
    service.recordDisposition({
      idempotencyKey: recorded.receipts[0]!.idempotencyKey,
      disposition: "not_actioned",
      reason: "withdrawn by requester",
    });
    service.closeTurn(envelope.id);
    const result = await service.reconcile();
    expect(result.retried).toBeGreaterThan(0);
    expect(
      store.getReceiptByIdempotencyKey(recorded.receipts[0]!.idempotencyKey)?.disposition,
    ).toBe("not_actioned");
  });

  it("survives compaction because receipts are independent of model context", () => {
    const { service, store } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "compacted" }));
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: [
        { requestIndex: 0, requestText: "Combat action economy" },
        { requestIndex: 1, requestText: "Investigate Strain" },
      ],
    });
    const sessionHistory: string[] = ["full chat that will be compacted"];
    sessionHistory.length = 0;
    expect(sessionHistory).toEqual([]);
    expect(store.listReceipts(envelope.id)).toHaveLength(2);
    expect(
      store.getReceiptByIdempotencyKey(recorded.receipts[0]!.idempotencyKey)?.requestText,
    ).toBe("Combat action economy");
    const replay = service.persistEnvelope(sampleSource({ messageId: "compacted" }));
    expect(replay.id).toBe(envelope.id);
  });

  it("keeps implementation workers on created or linked canonical tasks only", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "worker-isolation" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: [
        { requestIndex: 0, requestText: "Create NPC editor parity" },
        { requestIndex: 1, requestText: "Ambiguous duplicate" },
        { requestIndex: 2, requestText: "Withdrawn status check" },
      ],
    });
    service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 0,
      disposition: "created_new",
      canonicalTaskId: "task-npc",
    });
    service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 1,
      disposition: "needs_canonical_review",
      reason: "two matches",
      reviewOwner: "board",
      reviewDeadlineMs: Date.now() + 86_400_000,
    });
    service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 2,
      disposition: "not_actioned",
      reason: "withdrawn by requester",
    });
    expect(service.canonicalReady().map((receipt) => receipt.canonicalTaskId)).toEqual([
      "task-npc",
    ]);
    expect(
      service.audit().unresolved.some((entry) => entry.disposition === "needs_canonical_review"),
    ).toBe(true);
  });

  it("records backfill proven gaps and retention limits", () => {
    const { service } = createIntakeFixture();
    const run = service.recordBackfill({
      boardId: "mol-board",
      coverageBoundary:
        "Retained MoL Board trajectories 2026-06-18 through 2026-09-02; provider history and trashed Notion pages are unprovable.",
      findings: [
        {
          requestText: "Combat spells with action economy",
          confidence: "proven",
          reason: "acknowledged with no Notion mutation",
          sourceMessageId: "3BD6DCADA2836AC6FE60",
          sourceTimestampMs: 1_725_123_477_000,
        },
        {
          requestText: "Deleted or trashed Notion pages cannot be inspected",
          confidence: "unprovable",
          reason: "search cannot inspect trashed pages",
          retentionLimit: "Notion trash and provider history are outside retained evidence",
        },
      ],
    });
    expect(run.provenCount).toBe(1);
    expect(run.unprovableCount).toBe(1);
    expect(run.coverageBoundary).toContain("unprovable");
    expect(service.audit().backfill?.id).toBe(run.id);
  });

  it("alerts when a turn ends after receipt without a matching disposition count", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "incomplete-turn" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: tenRequests(),
    });
    const error = service.completenessOrError(envelope.id);
    expect(error).toBeInstanceOf(IntakeCompletenessError);
    expect(error?.extractedCount).toBe(10);
    expect(error?.disposedCount).toBe(0);
    service.store.insertAlert({
      envelopeId: envelope.id,
      kind: "turn_incomplete",
      message: error!.message,
    });
    expect(service.audit().alerts.some((alert) => alert.kind === "turn_incomplete")).toBe(true);
  });
});
