import type { Generated } from "openclaw/plugin-sdk/sqlite-runtime";

export const INTAKE_TERMINAL_DISPOSITIONS = [
  "created_new",
  "linked_existing",
  "completed",
  "needs_clarification",
  "not_actioned",
  "needs_canonical_review",
] as const;

export type IntakeTerminalDisposition = (typeof INTAKE_TERMINAL_DISPOSITIONS)[number];

export const INTAKE_REMOTE_DISPOSITIONS = ["created_new", "linked_existing", "completed"] as const;

export type IntakeRemoteDisposition = (typeof INTAKE_REMOTE_DISPOSITIONS)[number];

export const INTAKE_CANONICAL_READY_DISPOSITIONS = ["created_new", "linked_existing"] as const;

export type IntakeCanonicalReadyDisposition = (typeof INTAKE_CANONICAL_READY_DISPOSITIONS)[number];

export const INTAKE_OUTBOX_KINDS = [
  "notion_create",
  "notion_link",
  "notion_update",
  "reply_ack",
  "alert",
] as const;

export type IntakeOutboxKind = (typeof INTAKE_OUTBOX_KINDS)[number];

export const INTAKE_OUTBOX_STATUSES = [
  "pending",
  "in_flight",
  "delivered",
  "failed",
  "cancelled",
] as const;

export type IntakeOutboxStatus = (typeof INTAKE_OUTBOX_STATUSES)[number];

export const INTAKE_EXTRACTION_STATUSES = ["pending", "extracted"] as const;

export type IntakeExtractionStatus = (typeof INTAKE_EXTRACTION_STATUSES)[number];

export const INTAKE_BACKFILL_CONFIDENCE = ["proven", "likely", "unprovable"] as const;

export type IntakeBackfillConfidence = (typeof INTAKE_BACKFILL_CONFIDENCE)[number];

export const INTAKE_IDEMPOTENT_OUTBOX_KINDS = [
  "notion_create",
  "notion_link",
  "notion_update",
] as const;

export type IntakeEnvelope = {
  id: string;
  boardId: string;
  channel: string;
  accountId?: string;
  peerId?: string;
  messageId: string;
  senderId?: string;
  sourceTimestampMs?: number;
  receivedAtMs: number;
  sessionKey?: string;
  runId?: string;
  extractionStatus: IntakeExtractionStatus;
  extractedCount: number;
};

export type IntakeReceipt = {
  id: string;
  envelopeId: string;
  idempotencyKey: string;
  requestIndex: number;
  requestText: string;
  createdAtMs: number;
  requestedDisposition?: IntakeTerminalDisposition;
  disposition?: IntakeTerminalDisposition;
  dispositionReason?: string;
  canonicalTaskId?: string;
  canonicalTaskUrl?: string;
  reviewOwner?: string;
  reviewDeadlineMs?: number;
  turnId?: string;
  conflict?: string;
};

export type IntakeOutboxItem = {
  id: string;
  receiptId?: string;
  envelopeId?: string;
  kind: IntakeOutboxKind;
  status: IntakeOutboxStatus;
  attemptCount: number;
  nextAttemptAtMs: number;
  lastError?: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  claimToken?: string;
  createdAtMs: number;
  updatedAtMs: number;
  deliveredAtMs?: number;
};

export type IntakeAlert = {
  id: string;
  envelopeId?: string;
  receiptId?: string;
  kind: string;
  message: string;
  createdAtMs: number;
  acknowledgedAtMs?: number;
};

export type IntakeBackfillFinding = {
  sourceTimestampMs?: number;
  sourceMessageId?: string;
  requestText: string;
  confidence: IntakeBackfillConfidence;
  reason: string;
  retentionLimit?: string;
  canonicalTaskId?: string;
};

export type IntakeRetainedRequest = {
  sourceMessageId?: string;
  sourceTimestampMs?: number;
  requestText: string;
};

export type IntakeCanonicalEvidence = {
  id: string;
  url?: string;
  requestText?: string;
  title?: string;
};

export type IntakeBackfillRun = {
  id: string;
  boardId: string;
  startedAtMs: number;
  completedAtMs?: number;
  coverageBoundary: string;
  provenCount: number;
  likelyCount: number;
  unprovableCount: number;
  findings: IntakeBackfillFinding[];
};

export type IntakeUnresolvedEntry = {
  kind:
    | "pending_extraction"
    | "undisposed_receipt"
    | "pending_remote"
    | "reviewable"
    | "undelivered_outbox"
    | "replay_conflict";
  envelopeId: string;
  receiptId?: string;
  outboxId?: string;
  boardId: string;
  channel: string;
  messageId: string;
  sourceTimestampMs?: number;
  receivedAtMs: number;
  requestText?: string;
  reason: string;
  disposition?: IntakeTerminalDisposition;
};

export type IntakeSourceRef = {
  boardId: string;
  channel: string;
  accountId?: string;
  peerId?: string;
  messageId: string;
  senderId?: string;
  sourceTimestampMs?: number;
  sessionKey?: string;
  runId?: string;
};

export type IntakeAtomicRequest = {
  requestIndex: number;
  requestText: string;
};

export type IntakeDispositionInput = {
  idempotencyKey?: string;
  envelopeId?: string;
  requestIndex?: number;
  disposition: IntakeTerminalDisposition;
  reason?: string;
  canonicalTaskId?: string;
  canonicalTaskUrl?: string;
  reviewOwner?: string;
  reviewDeadlineMs?: number;
  turnId?: string;
  notionDataSourceId?: string;
};

export type IntakeDeliveryResult =
  | { ok: true; remoteId?: string }
  | { ok: false; error: string; retryable: boolean }
  | { ok: false; awaitingExternal: true; error?: string };

export type IntakeNotionClaim = {
  outboxId: string;
  outboxIdempotencyKey: string;
  claimToken: string;
  kind: "notion_create" | "notion_link" | "notion_update";
  status: "in_flight";
  intakeIdempotencyKey: string;
  disposition?: IntakeTerminalDisposition;
  requestText: string;
  boardId: string;
  notionDataSourceId?: string;
  messageId: string;
  envelopeId: string;
  receiptId?: string;
};

export type IntakeDatabase = {
  intake_envelopes: {
    id: string;
    board_id: string;
    channel: string;
    account_id: string | null;
    peer_id: string | null;
    message_id: string;
    sender_id: string | null;
    source_timestamp_ms: number | null;
    received_at_ms: number;
    session_key: string | null;
    run_id: string | null;
    extraction_status: IntakeExtractionStatus;
    extracted_count: number;
  };
  intake_receipts: {
    id: string;
    envelope_id: string;
    idempotency_key: string;
    request_index: number;
    request_text: string;
    created_at_ms: number;
    requested_disposition: IntakeTerminalDisposition | null;
    disposition: IntakeTerminalDisposition | null;
    disposition_reason: string | null;
    canonical_task_id: string | null;
    canonical_task_url: string | null;
    review_owner: string | null;
    review_deadline_ms: number | null;
    turn_id: string | null;
    conflict: string | null;
  };
  intake_outbox: {
    id: string;
    receipt_id: string | null;
    envelope_id: string | null;
    kind: IntakeOutboxKind;
    status: IntakeOutboxStatus;
    attempt_count: number;
    next_attempt_at_ms: number;
    last_error: string | null;
    payload_json: string;
    idempotency_key: string;
    claim_token: string | null;
    created_at_ms: number;
    updated_at_ms: number;
    delivered_at_ms: number | null;
  };
  intake_alerts: {
    id: string;
    envelope_id: string | null;
    receipt_id: string | null;
    kind: string;
    message: string;
    created_at_ms: number;
    acknowledged_at_ms: number | null;
  };
  intake_backfill_runs: {
    id: string;
    board_id: string;
    started_at_ms: number;
    completed_at_ms: number | null;
    coverage_boundary: string;
    proven_count: number;
    likely_count: number;
    unprovable_count: number;
    result_json: string;
  };
  intake_schema_migrations: {
    id: string;
    applied_at: Generated<number> | number;
  };
};
