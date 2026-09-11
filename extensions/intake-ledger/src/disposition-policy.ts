import type { IntakeDispositionInput, IntakeReceipt, IntakeTerminalDisposition } from "./types.js";
import { INTAKE_REMOTE_DISPOSITIONS } from "./types.js";

export class IntakeClaimAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeClaimAuthorityError";
  }
}

export class IntakeReplayConflictError extends Error {
  readonly idempotencyKey: string;
  readonly stored: string;
  readonly received: string;

  constructor(params: { idempotencyKey: string; stored: string; received: string }) {
    super(
      `intake replay conflict for ${params.idempotencyKey}: stored ${params.stored}; received ${params.received}`,
    );
    this.name = "IntakeReplayConflictError";
    this.idempotencyKey = params.idempotencyKey;
    this.stored = params.stored;
    this.received = params.received;
  }
}

export function isRemoteDisposition(
  value: IntakeTerminalDisposition,
): value is (typeof INTAKE_REMOTE_DISPOSITIONS)[number] {
  return (INTAKE_REMOTE_DISPOSITIONS as readonly string[]).includes(value);
}

export function canonicalIdentityOf(input: {
  canonicalTaskId?: string;
  canonicalTaskUrl?: string;
}): { canonicalTaskId?: string; canonicalTaskUrl?: string } | undefined {
  const canonicalTaskId = input.canonicalTaskId?.trim() || undefined;
  const canonicalTaskUrl = input.canonicalTaskUrl?.trim() || undefined;
  if (!canonicalTaskId && !canonicalTaskUrl) {
    return undefined;
  }
  return { canonicalTaskId, canonicalTaskUrl };
}

export function dispositionFingerprint(input: {
  disposition?: IntakeTerminalDisposition | null;
  reason?: string | null;
  canonicalTaskId?: string | null;
  canonicalTaskUrl?: string | null;
  reviewOwner?: string | null;
  reviewDeadlineMs?: number | null;
}): string {
  return JSON.stringify({
    disposition: input.disposition ?? null,
    reason: input.reason ?? null,
    canonicalTaskId: input.canonicalTaskId ?? null,
    canonicalTaskUrl: input.canonicalTaskUrl ?? null,
    reviewOwner: input.reviewOwner ?? null,
    reviewDeadlineMs: input.reviewDeadlineMs ?? null,
  });
}

export function receiptDispositionFingerprint(receipt: IntakeReceipt): string {
  return dispositionFingerprint({
    disposition: receipt.disposition ?? receipt.requestedDisposition ?? null,
    reason: receipt.dispositionReason ?? null,
    canonicalTaskId: receipt.canonicalTaskId ?? null,
    canonicalTaskUrl: receipt.canonicalTaskUrl ?? null,
    reviewOwner: receipt.reviewOwner ?? null,
    reviewDeadlineMs: receipt.reviewDeadlineMs ?? null,
  });
}

export function validateDispositionFields(input: IntakeDispositionInput): void {
  const identity = canonicalIdentityOf(input);
  if (input.disposition === "not_actioned" || input.disposition === "needs_clarification") {
    if (!input.reason?.trim()) {
      throw new Error(`${input.disposition} requires a reason`);
    }
    return;
  }
  if (input.disposition === "needs_canonical_review") {
    if (!input.reviewOwner?.trim()) {
      throw new Error("needs_canonical_review requires reviewOwner");
    }
    if (
      typeof input.reviewDeadlineMs !== "number" ||
      !Number.isFinite(input.reviewDeadlineMs) ||
      input.reviewDeadlineMs <= 0
    ) {
      throw new Error("needs_canonical_review requires reviewDeadlineMs");
    }
    return;
  }
  if (input.disposition === "linked_existing" && !identity) {
    throw new Error("linked_existing requires canonicalTaskId or canonicalTaskUrl");
  }
}

export function isConfirmedRemoteResult(input: IntakeDispositionInput): boolean {
  return isRemoteDisposition(input.disposition) && Boolean(canonicalIdentityOf(input));
}

export function isRequestedRemoteWork(input: IntakeDispositionInput): boolean {
  return isRemoteDisposition(input.disposition) && !canonicalIdentityOf(input);
}

export function isCanonicalIdentityConfirmation(
  stored: IntakeReceipt,
  incoming: IntakeDispositionInput,
): boolean {
  if (!isConfirmedRemoteResult(incoming)) {
    return false;
  }
  const requested = stored.requestedDisposition ?? stored.disposition;
  if (!requested || requested !== incoming.disposition) {
    return false;
  }
  if (canonicalIdentityOf(stored)) {
    return false;
  }
  const storedCore = dispositionFingerprint({
    disposition: requested,
    reason: stored.dispositionReason ?? null,
    canonicalTaskId: null,
    canonicalTaskUrl: null,
    reviewOwner: stored.reviewOwner ?? null,
    reviewDeadlineMs: stored.reviewDeadlineMs ?? null,
  });
  const incomingCore = dispositionFingerprint({
    disposition: incoming.disposition,
    reason: incoming.reason ?? null,
    canonicalTaskId: null,
    canonicalTaskUrl: null,
    reviewOwner: incoming.reviewOwner ?? null,
    reviewDeadlineMs: incoming.reviewDeadlineMs ?? null,
  });
  return storedCore === incomingCore;
}

export function validateRequestIndices(requests: readonly { requestIndex: number }[]): void {
  const seen = new Set<number>();
  for (const request of requests) {
    if (!Number.isInteger(request.requestIndex) || request.requestIndex < 0) {
      throw new Error(`requestIndex must be a unique nonnegative integer: ${request.requestIndex}`);
    }
    if (seen.has(request.requestIndex)) {
      throw new Error(`duplicate requestIndex ${request.requestIndex}`);
    }
    seen.add(request.requestIndex);
  }
}
