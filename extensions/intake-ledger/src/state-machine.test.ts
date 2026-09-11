import { describe, expect, it } from "vitest";
import { acknowledgementMatches, buildAcknowledgement } from "./ack.js";
import { createRecordingAdapter } from "./adapters.js";
import { createProductionDeliveryAdapters } from "./delivery.js";
import { IntakeReplayConflictError } from "./disposition-policy.js";
import { IntakeLedgerService } from "./service.js";
import { createIntakeClock, createIntakeFixture, sampleSource } from "./test-harness.js";

describe("intake ledger state machine", () => {
  it("does not mark created_new terminal before a confirmed canonical identity", async () => {
    const { service, store } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "pending-create" }));
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Create NPC editor" }],
    });
    const result = service.recordDisposition({
      idempotencyKey: recorded.receipts[0]!.idempotencyKey,
      disposition: "created_new",
    });
    expect(result.pendingRemote).toBe(true);
    expect(result.receipt.disposition).toBeUndefined();
    expect(result.receipt.requestedDisposition).toBe("created_new");
    expect(result.outbox.some((item) => item.kind === "notion_create")).toBe(true);
    expect(service.completenessOrError(envelope.id)).toBeTruthy();
    expect(store.listUnresolved().some((entry) => entry.kind === "pending_remote")).toBe(true);
  });

  it("does not enqueue again when the confirmed canonical result is recorded", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "already-created" }));
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Shelf Start button" }],
    });
    const first = service.recordDisposition({
      idempotencyKey: recorded.receipts[0]!.idempotencyKey,
      disposition: "created_new",
      canonicalTaskId: "task-1",
      canonicalTaskUrl: "https://notion.so/task-1",
    });
    expect(first.pendingRemote).toBe(false);
    expect(first.receipt.disposition).toBe("created_new");
    expect(first.outbox.filter((item) => item.kind.startsWith("notion_"))).toEqual([]);
    const replay = service.recordDisposition({
      idempotencyKey: recorded.receipts[0]!.idempotencyKey,
      disposition: "created_new",
      canonicalTaskId: "task-1",
      canonicalTaskUrl: "https://notion.so/task-1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.outbox.filter((item) => item.kind.startsWith("notion_"))).toEqual([]);
  });

  it("rejects replay of the same idempotency key with changed request text", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "text-conflict" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "original request" }],
    });
    expect(() =>
      service.recordRequests({
        envelopeId: envelope.id,
        requests: [{ requestIndex: 0, requestText: "changed request" }],
      }),
    ).toThrow(IntakeReplayConflictError);
  });

  it("rejects the same disposition with changed task identity as a conflict", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "disp-conflict" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "link existing" }],
    });
    service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 0,
      disposition: "linked_existing",
      canonicalTaskId: "task-a",
    });
    expect(() =>
      service.recordDisposition({
        envelopeId: envelope.id,
        requestIndex: 0,
        disposition: "linked_existing",
        canonicalTaskId: "task-b",
      }),
    ).toThrow(IntakeReplayConflictError);
  });

  it("requires unique nonnegative request indices", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "indices" }));
    expect(() =>
      service.recordRequests({
        envelopeId: envelope.id,
        requests: [
          { requestIndex: 0, requestText: "one" },
          { requestIndex: 0, requestText: "two" },
        ],
      }),
    ).toThrow(/duplicate requestIndex/);
    expect(() =>
      service.recordRequests({
        envelopeId: envelope.id,
        requests: [{ requestIndex: -1, requestText: "bad" }],
      }),
    ).toThrow(/nonnegative/);
  });

  it("lets only the current claim token settle an in-flight outbox row", async () => {
    const clock = createIntakeClock();
    const { service, store } = createIntakeFixture({
      now: clock.now,
      adapters: [createRecordingAdapter({ kind: "notion_create" })],
    });
    const envelope = service.persistEnvelope(sampleSource({ messageId: "claim-token" }));
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Create task" }],
    });
    service.recordDisposition({
      idempotencyKey: recorded.receipts[0]!.idempotencyKey,
      disposition: "created_new",
    });
    const [item] = store.listDueOutbox();
    const claimed = store.claimOutbox(item!.id);
    expect(claimed?.claimToken).toBeTruthy();
    const stale = store.recordDeliveryResult(
      claimed!.id,
      { ok: true, remoteId: "stale" },
      "not-the-claim",
    );
    expect(stale.status).toBe("in_flight");
    const settled = store.recordDeliveryResult(
      claimed!.id,
      { ok: true, remoteId: "task-live" },
      claimed!.claimToken,
    );
    expect(settled.status).toBe("delivered");
    const regress = store.recordDeliveryResult(
      claimed!.id,
      { ok: false, error: "late failure", retryable: true },
      claimed!.claimToken,
    );
    expect(regress.status).toBe("delivered");
  });

  it("treats a stuck non-idempotent send as reviewable instead of silently retrying", () => {
    const clock = createIntakeClock();
    const { store } = createIntakeFixture({ now: clock.now });
    const envelope = store.persistEnvelope(sampleSource({ messageId: "ambiguous-send" }));
    store.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Ack me" }],
    });
    store.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 0,
      disposition: "not_actioned",
      reason: "withdrawn by requester",
    });
    store.closeTurn(envelope.id);
    const ack = store.listOutboxForEnvelope(envelope.id).find((item) => item.kind === "reply_ack");
    const claimed = store.claimOutbox(ack!.id);
    clock.advance(10 * 60 * 1000);
    store.recoverStuckInFlight({ timeoutMs: 1000 });
    expect(store.getOutbox(claimed!.id)?.status).toBe("failed");
    expect(store.listOpenAlerts().some((alert) => alert.kind.includes("reply_ack"))).toBe(true);
  });

  it("fails a missing Notion automation job as a bounded configuration error", async () => {
    const fixture = createIntakeFixture();
    const service = new IntakeLedgerService(
      fixture.store,
      fixture.config,
      createProductionDeliveryAdapters({ config: fixture.config }),
    );
    const { store } = fixture;
    const envelope = service.persistEnvelope(sampleSource({ messageId: "no-job" }));
    const recorded = service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Need Notion" }],
    });
    service.recordDisposition({
      idempotencyKey: recorded.receipts[0]!.idempotencyKey,
      disposition: "created_new",
    });
    const result = await service.reconcile();
    expect(result.failed).toBeGreaterThan(0);
    expect(result.retried).toBe(0);
    const outbox = store.listOutboxForReceipt(recorded.receipts[0]!.id)[0];
    expect(outbox?.status).toBe("failed");
    expect(outbox?.lastError).toMatch(/automation job is not configured/);
  });

  it("requires extracted count and every task link or reason in the acknowledgement", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "ack-text" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: [
        { requestIndex: 0, requestText: "Create task" },
        { requestIndex: 1, requestText: "Skip this" },
      ],
    });
    service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 0,
      disposition: "created_new",
      canonicalTaskId: "task-1",
      canonicalTaskUrl: "https://notion.so/task-1",
    });
    service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 1,
      disposition: "not_actioned",
      reason: "withdrawn by requester",
    });
    const ack = buildAcknowledgement({
      envelope: service.store.getEnvelope(envelope.id)!,
      receipts: service.store.listReceipts(envelope.id),
    });
    expect(ack.requiredSnippets).toEqual(
      expect.arrayContaining(["extracted 2", "https://notion.so/task-1", "withdrawn by requester"]),
    );
    expect(acknowledgementMatches("thanks, done", ack)).toBe(false);
    expect(acknowledgementMatches(ack.text, ack)).toBe(true);
  });

  it("surfaces older pending envelopes instead of only the newest", () => {
    const { service } = createIntakeFixture();
    const first = service.persistEnvelope(sampleSource({ messageId: "old" }));
    const second = service.persistEnvelope(sampleSource({ messageId: "new" }));
    expect(first.id).not.toBe(second.id);
    const pending = service.pendingExtractionEnvelopes(sampleSource().sessionKey);
    expect(pending.map((envelope) => envelope.messageId)).toEqual(["old", "new"]);
  });

  it("derives backfill gaps from retained requests and canonical evidence", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "gap" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: [{ requestIndex: 0, requestText: "Recorded request" }],
    });
    const run = service.recordBackfill({
      boardId: "mol-board",
      coverageBoundary: "retained 2026-06-18 through 2026-09-02",
      retentionLimit: "provider history is unprovable",
      retainedRequests: [
        { requestText: "Recorded request", sourceMessageId: "gap" },
        { requestText: "Combat spells with action economy", sourceMessageId: "missing" },
      ],
      canonicalTasks: [{ id: "task-x", title: "Unrelated canonical" }],
    });
    expect(run.provenCount).toBeGreaterThan(0);
    expect(run.unprovableCount).toBe(1);
    expect(
      run.findings.some((finding) => finding.requestText === "Combat spells with action economy"),
    ).toBe(true);
  });

  it("requires owner and deadline for canonical review and a reason for not_actioned", () => {
    const { service } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "required-fields" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: [
        { requestIndex: 0, requestText: "review" },
        { requestIndex: 1, requestText: "skip" },
      ],
    });
    expect(() =>
      service.recordDisposition({
        envelopeId: envelope.id,
        requestIndex: 0,
        disposition: "needs_canonical_review",
      }),
    ).toThrow(/reviewOwner/);
    expect(() =>
      service.recordDisposition({
        envelopeId: envelope.id,
        requestIndex: 1,
        disposition: "not_actioned",
      }),
    ).toThrow(/reason/);
  });
});
