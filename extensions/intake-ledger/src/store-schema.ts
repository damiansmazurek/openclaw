import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const INTAKE_SCHEMA_VERSION = 2;
export const MAX_PERSISTED_ERROR_CHARS = 300;
export const MAX_OUTBOX_ATTEMPTS = 8;
export const INTAKE_SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const INTAKE_SQLITE_DIR_MODE = 0o700;
export const INTAKE_SQLITE_FILE_MODE = 0o600;
export const MAX_OUTBOX_BACKOFF_MS = 15 * 60 * 1000;
export const INTAKE_DB_RELATIVE_PATH = ["plugins", "intake-ledger"] as const;

export function resolveIntakeLedgerDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), ...INTAKE_DB_RELATIVE_PATH);
}

export function nextOutboxBackoffMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount, 10));
  return Math.min(1000 * 2 ** exponent, MAX_OUTBOX_BACKOFF_MS);
}

export const INTAKE_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS intake_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS intake_envelopes (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  account_id TEXT,
  peer_id TEXT,
  message_id TEXT NOT NULL,
  sender_id TEXT,
  source_timestamp_ms INTEGER,
  received_at_ms INTEGER NOT NULL,
  session_key TEXT,
  run_id TEXT,
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('pending', 'extracted')),
  extracted_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (board_id, channel, message_id)
) STRICT;
CREATE INDEX IF NOT EXISTS intake_envelopes_session_idx
  ON intake_envelopes(session_key, received_at_ms);
CREATE INDEX IF NOT EXISTS intake_envelopes_status_idx
  ON intake_envelopes(extraction_status, received_at_ms);

CREATE TABLE IF NOT EXISTS intake_receipts (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES intake_envelopes(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_index INTEGER NOT NULL,
  request_text TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  requested_disposition TEXT CHECK (
    requested_disposition IS NULL OR requested_disposition IN (
      'created_new',
      'linked_existing',
      'completed',
      'needs_clarification',
      'not_actioned',
      'needs_canonical_review'
    )
  ),
  disposition TEXT CHECK (
    disposition IS NULL OR disposition IN (
      'created_new',
      'linked_existing',
      'completed',
      'needs_clarification',
      'not_actioned',
      'needs_canonical_review'
    )
  ),
  disposition_reason TEXT,
  canonical_task_id TEXT,
  canonical_task_url TEXT,
  review_owner TEXT,
  review_deadline_ms INTEGER,
  turn_id TEXT,
  conflict TEXT,
  UNIQUE (envelope_id, request_index)
) STRICT;
CREATE INDEX IF NOT EXISTS intake_receipts_envelope_idx
  ON intake_receipts(envelope_id, request_index);
CREATE INDEX IF NOT EXISTS intake_receipts_disposition_idx
  ON intake_receipts(disposition, created_at_ms);

CREATE TABLE IF NOT EXISTS intake_outbox (
  id TEXT PRIMARY KEY,
  receipt_id TEXT REFERENCES intake_receipts(id) ON DELETE CASCADE,
  envelope_id TEXT REFERENCES intake_envelopes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'notion_create',
    'notion_link',
    'notion_update',
    'reply_ack',
    'alert'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'pending',
    'in_flight',
    'delivered',
    'failed',
    'cancelled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  last_error TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE,
  claim_token TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS intake_outbox_retry_idx
  ON intake_outbox(status, next_attempt_at_ms);

CREATE TABLE IF NOT EXISTS intake_alerts (
  id TEXT PRIMARY KEY,
  envelope_id TEXT,
  receipt_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  acknowledged_at_ms INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS intake_alerts_open_idx
  ON intake_alerts(acknowledged_at_ms, created_at_ms);

CREATE TABLE IF NOT EXISTS intake_backfill_runs (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  coverage_boundary TEXT NOT NULL,
  proven_count INTEGER NOT NULL DEFAULT 0,
  likely_count INTEGER NOT NULL DEFAULT 0,
  unprovable_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '[]'
) STRICT;
`;
