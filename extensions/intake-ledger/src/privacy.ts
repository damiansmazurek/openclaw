import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MAX_REQUEST_TEXT_CHARS } from "./request-bytes.js";
import { MAX_PERSISTED_ERROR_CHARS } from "./store-schema.js";
import { normalizeSourceTimestampMs } from "./timestamps.js";
import type { IntakeSourceRef } from "./types.js";

export { admitAtomicRequests, admitRequestText, MAX_REQUEST_TEXT_CHARS } from "./request-bytes.js";

export function redactPersistedError(value: unknown): string {
  const raw =
    typeof value === "string" ? value : value instanceof Error ? value.message : String(value);
  const firstLine = raw.split(/\r?\n/)[0]?.trim() || "error";
  const stripped = firstLine.replace(/\/[^\s:]+/g, "[path]");
  return stripped.length > MAX_PERSISTED_ERROR_CHARS
    ? stripped.slice(0, MAX_PERSISTED_ERROR_CHARS)
    : stripped;
}

export function boundAlertMessage(value: string): string {
  return redactPersistedError(value);
}

export function sanitizeRequestText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  if (value.length > MAX_REQUEST_TEXT_CHARS) {
    return undefined;
  }
  return value;
}

export function sourceRefFromInbound(params: {
  boardId: string;
  channel: string;
  accountId?: string;
  peerId?: string;
  messageId?: string;
  senderId?: string;
  sourceTimestampMs?: number;
  sessionKey?: string;
  runId?: string;
}): IntakeSourceRef | undefined {
  const messageId = normalizeOptionalString(params.messageId);
  if (!messageId) {
    return undefined;
  }
  return {
    boardId: params.boardId,
    channel: params.channel,
    accountId: normalizeOptionalString(params.accountId),
    peerId: normalizeOptionalString(params.peerId),
    messageId,
    senderId: normalizeOptionalString(params.senderId),
    sourceTimestampMs: normalizeSourceTimestampMs(params.sourceTimestampMs),
    sessionKey: normalizeOptionalString(params.sessionKey),
    runId: normalizeOptionalString(params.runId),
  };
}

export function collectPeerIds(params: {
  from?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}): string[] {
  const peers = [
    normalizeOptionalString(params.from),
    normalizeOptionalString(params.conversationId),
    normalizeOptionalString(params.metadata?.to),
    normalizeOptionalString(params.metadata?.originatingTo),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(peers)];
}
