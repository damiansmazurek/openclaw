import type { Selectable } from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  IntakeAlert,
  IntakeBackfillFinding,
  IntakeBackfillRun,
  IntakeDatabase,
  IntakeEnvelope,
  IntakeOutboxItem,
  IntakeOutboxKind,
  IntakeReceipt,
  IntakeTerminalDisposition,
} from "./types.js";
import { INTAKE_TERMINAL_DISPOSITIONS } from "./types.js";

export function optionalText(value: string | null | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function optionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isTerminalDisposition(value: unknown): value is IntakeTerminalDisposition {
  return (
    typeof value === "string" && (INTAKE_TERMINAL_DISPOSITIONS as readonly string[]).includes(value)
  );
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseFindings(raw: string): IntakeBackfillFinding[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as IntakeBackfillFinding[]) : [];
  } catch {
    return [];
  }
}

export function toEnvelope(row: Selectable<IntakeDatabase["intake_envelopes"]>): IntakeEnvelope {
  return {
    id: row.id,
    boardId: row.board_id,
    channel: row.channel,
    accountId: optionalText(row.account_id),
    peerId: optionalText(row.peer_id),
    messageId: row.message_id,
    senderId: optionalText(row.sender_id),
    sourceTimestampMs: optionalNumber(row.source_timestamp_ms),
    receivedAtMs: row.received_at_ms,
    sessionKey: optionalText(row.session_key),
    runId: optionalText(row.run_id),
    extractionStatus: row.extraction_status,
    extractedCount: row.extracted_count,
  };
}

export function toReceipt(row: Selectable<IntakeDatabase["intake_receipts"]>): IntakeReceipt {
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    idempotencyKey: row.idempotency_key,
    requestIndex: row.request_index,
    requestText: row.request_text,
    createdAtMs: row.created_at_ms,
    requestedDisposition: row.requested_disposition ?? undefined,
    disposition: row.disposition ?? undefined,
    dispositionReason: optionalText(row.disposition_reason),
    canonicalTaskId: optionalText(row.canonical_task_id),
    canonicalTaskUrl: optionalText(row.canonical_task_url),
    reviewOwner: optionalText(row.review_owner),
    reviewDeadlineMs: optionalNumber(row.review_deadline_ms),
    turnId: optionalText(row.turn_id),
    conflict: optionalText(row.conflict),
  };
}

export function toOutbox(row: Selectable<IntakeDatabase["intake_outbox"]>): IntakeOutboxItem {
  return {
    id: row.id,
    receiptId: optionalText(row.receipt_id),
    envelopeId: optionalText(row.envelope_id),
    kind: row.kind,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAtMs: row.next_attempt_at_ms,
    lastError: optionalText(row.last_error),
    payload: parsePayload(row.payload_json),
    idempotencyKey: row.idempotency_key,
    claimToken: optionalText(row.claim_token),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    deliveredAtMs: optionalNumber(row.delivered_at_ms),
  };
}

export function toAlert(row: Selectable<IntakeDatabase["intake_alerts"]>): IntakeAlert {
  return {
    id: row.id,
    envelopeId: optionalText(row.envelope_id),
    receiptId: optionalText(row.receipt_id),
    kind: row.kind,
    message: row.message,
    createdAtMs: row.created_at_ms,
    acknowledgedAtMs: optionalNumber(row.acknowledged_at_ms),
  };
}

export function toBackfill(
  row: Selectable<IntakeDatabase["intake_backfill_runs"]>,
): IntakeBackfillRun {
  return {
    id: row.id,
    boardId: row.board_id,
    startedAtMs: row.started_at_ms,
    completedAtMs: optionalNumber(row.completed_at_ms),
    coverageBoundary: row.coverage_boundary,
    provenCount: row.proven_count,
    likelyCount: row.likely_count,
    unprovableCount: row.unprovable_count,
    findings: parseFindings(row.result_json),
  };
}

export function outboxKindForDisposition(
  disposition: IntakeTerminalDisposition,
): IntakeOutboxKind | undefined {
  if (disposition === "created_new") {
    return "notion_create";
  }
  if (disposition === "linked_existing") {
    return "notion_link";
  }
  if (disposition === "completed") {
    return "notion_update";
  }
  return undefined;
}
