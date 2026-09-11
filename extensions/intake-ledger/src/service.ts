import { buildAcknowledgement, type IntakeAcknowledgement } from "./ack.js";
import { deliverOutboxItem, type IntakeDeliveryAdapter } from "./adapters.js";
import { auditCanonicalCoverage } from "./backfill-audit.js";
import type { IntakeBoardConfig, IntakeLedgerConfig } from "./config.js";
import { IntakeCompletenessError, IntakeLedgerStore } from "./store.js";
import type {
  IntakeAtomicRequest,
  IntakeBackfillFinding,
  IntakeBackfillRun,
  IntakeCanonicalEvidence,
  IntakeDispositionInput,
  IntakeEnvelope,
  IntakeOutboxItem,
  IntakeReceipt,
  IntakeRetainedRequest,
  IntakeSourceRef,
  IntakeUnresolvedEntry,
} from "./types.js";

export type IntakeReconcileResult = {
  recoveredInFlight: number;
  attempted: number;
  delivered: number;
  retried: number;
  failed: number;
  awaiting: number;
  alerts: number;
  unresolved: IntakeUnresolvedEntry[];
};

export class IntakeLedgerService {
  constructor(
    readonly store: IntakeLedgerStore,
    readonly config: IntakeLedgerConfig,
    private readonly adapters: IntakeDeliveryAdapter[] = [],
  ) {}

  persistEnvelope(source: IntakeSourceRef): IntakeEnvelope {
    return this.store.persistEnvelope(source);
  }

  recordRequests(params: {
    envelopeId: string;
    requests: IntakeAtomicRequest[];
    turnId?: string;
  }): { envelope: IntakeEnvelope; receipts: IntakeReceipt[]; created: number } {
    return this.store.recordRequests(params);
  }

  recordDisposition(input: IntakeDispositionInput) {
    return this.store.recordDisposition(input);
  }

  closeTurn(envelopeId: string) {
    const closed = this.store.closeTurn(envelopeId);
    return {
      ...closed,
      acknowledgement: buildAcknowledgement(closed),
    };
  }

  completenessOrError(envelopeId: string): IntakeCompletenessError | undefined {
    try {
      this.store.assertCompleteness(envelopeId);
      return undefined;
    } catch (error) {
      if (error instanceof IntakeCompletenessError) {
        return error;
      }
      throw error;
    }
  }

  acknowledgementFor(envelopeId: string): IntakeAcknowledgement | undefined {
    if (this.completenessOrError(envelopeId)) {
      return undefined;
    }
    const envelope = this.store.getEnvelope(envelopeId);
    if (!envelope) {
      return undefined;
    }
    return buildAcknowledgement({
      envelope,
      receipts: this.store.listReceipts(envelopeId),
    });
  }

  audit(params?: { olderThanMs?: number }): {
    unresolved: IntakeUnresolvedEntry[];
    alerts: ReturnType<IntakeLedgerStore["listOpenAlerts"]>;
    backfill?: IntakeBackfillRun;
  } {
    return {
      unresolved: this.store.listUnresolved(params),
      alerts: this.store.listOpenAlerts(),
      backfill: this.store.latestBackfill(),
    };
  }

  canonicalReady(boardId?: string): IntakeReceipt[] {
    return this.store.listCanonicalReady(boardId);
  }

  recordBackfill(params: {
    boardId: string;
    coverageBoundary: string;
    findings?: IntakeBackfillFinding[];
    retainedRequests?: IntakeRetainedRequest[];
    canonicalTasks?: IntakeCanonicalEvidence[];
    retentionLimit?: string;
  }): IntakeBackfillRun {
    const boardReceipts = this.store.listReceiptsForBoard(params.boardId);
    const derived =
      params.retainedRequests && (params.canonicalTasks || params.retentionLimit)
        ? auditCanonicalCoverage({
            retainedRequests: params.retainedRequests,
            canonicalTasks: params.canonicalTasks ?? [],
            receipts: boardReceipts,
            coverageBoundary: params.coverageBoundary,
            retentionLimit: params.retentionLimit,
          })
        : [];
    const findings = derived.length > 0 ? derived : (params.findings ?? []);
    return this.store.recordBackfill({
      boardId: params.boardId,
      coverageBoundary: params.coverageBoundary,
      findings,
    });
  }

  ackDelivery(idempotencyKey: string, remoteId?: string, claimToken?: string) {
    const item = this.store.ackDelivery(idempotencyKey, remoteId, claimToken);
    if (
      item?.status === "delivered" &&
      item.receiptId &&
      (item.kind === "notion_create" ||
        item.kind === "notion_link" ||
        item.kind === "notion_update")
    ) {
      this.store.confirmReceiptFromRemote({
        receiptId: item.receiptId,
        canonicalTaskId: remoteId ?? payloadString(item.payload, "remoteId"),
        canonicalTaskUrl: payloadString(item.payload, "canonicalTaskUrl"),
      });
    }
    return item;
  }

  pendingExtractionForSession(sessionKey: string | undefined): IntakeEnvelope | undefined {
    return this.store.getPendingEnvelopeForSession(sessionKey);
  }

  pendingExtractionEnvelopes(sessionKey: string | undefined): IntakeEnvelope[] {
    return this.store.listPendingExtractionEnvelopes(sessionKey);
  }

  envelopesForSession(sessionKey: string | undefined): IntakeEnvelope[] {
    return this.store.listEnvelopesForSession(sessionKey);
  }

  latestEnvelopeForSession(sessionKey: string | undefined): IntakeEnvelope | undefined {
    return this.store.getLatestEnvelopeForSession(sessionKey);
  }

  settleReplyAck(params: {
    envelopeId: string;
    success: boolean;
    error?: string;
    remoteId?: string;
  }): IntakeOutboxItem | undefined {
    const item = this.store
      .listOutboxForEnvelope(params.envelopeId)
      .find((entry) => entry.kind === "reply_ack");
    if (!item) {
      return undefined;
    }
    if (params.success) {
      return this.store.recordDeliveryResult(
        item.id,
        { ok: true, remoteId: params.remoteId },
        item.status === "in_flight" ? item.claimToken : undefined,
      );
    }
    return this.store.recordDeliveryResult(
      item.id,
      { ok: false, error: params.error ?? "message_sent failed", retryable: true },
      item.status === "in_flight" ? item.claimToken : undefined,
    );
  }

  alertThreshold(boardId?: string): number {
    const board = this.config.boards.find((entry) => entry.id === boardId);
    return (
      board?.unresolvedAlertAfterMs ?? this.config.boards[0]?.unresolvedAlertAfterMs ?? 3_600_000
    );
  }

  async reconcile(): Promise<IntakeReconcileResult> {
    const recoveredInFlight = this.store.recoverStuckInFlight({
      timeoutMs: this.config.inFlightTimeoutMs,
    });
    const due = this.store.listDueOutbox();
    let delivered = 0;
    let retried = 0;
    let failed = 0;
    let awaiting = 0;
    for (const item of due) {
      const claimed = this.store.claimOutbox(item.id);
      if (!claimed) {
        continue;
      }
      const result = await deliverOutboxItem({ item: claimed, adapters: this.adapters });
      const updated = this.store.recordDeliveryResult(claimed.id, result, claimed.claimToken);
      if (updated.status === "delivered") {
        delivered += 1;
        if (
          claimed.receiptId &&
          (claimed.kind === "notion_create" ||
            claimed.kind === "notion_link" ||
            claimed.kind === "notion_update")
        ) {
          this.store.confirmReceiptFromRemote({
            receiptId: claimed.receiptId,
            canonicalTaskId: result.ok ? result.remoteId : undefined,
          });
        }
      } else if (updated.status === "failed") {
        failed += 1;
      } else if (updated.status === "in_flight") {
        awaiting += 1;
      } else {
        retried += 1;
      }
    }
    const unresolved = this.store.listUnresolved({
      olderThanMs: this.alertThreshold(),
    });
    for (const entry of unresolved) {
      this.store.insertAlert({
        envelopeId: entry.envelopeId,
        receiptId: entry.receiptId,
        kind: `unresolved_${entry.kind}`,
        message: `${entry.channel} ${entry.messageId}: ${entry.reason}`,
      });
    }
    return {
      recoveredInFlight,
      attempted: due.length,
      delivered,
      retried,
      failed,
      awaiting,
      alerts: this.store.listOpenAlerts().length,
      unresolved,
    };
  }
}

export function formatAcknowledgement(params: {
  envelope: IntakeEnvelope;
  receipts: IntakeReceipt[];
}): string {
  return buildAcknowledgement(params).text;
}

export function boardNotionDataSource(
  boards: readonly IntakeBoardConfig[],
  boardId: string,
): string | undefined {
  return boards.find((board) => board.id === boardId)?.notionDataSourceId;
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type { IntakeOutboxItem };
