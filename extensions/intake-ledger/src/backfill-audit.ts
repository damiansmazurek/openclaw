import type {
  IntakeBackfillFinding,
  IntakeCanonicalEvidence,
  IntakeReceipt,
  IntakeRetainedRequest,
} from "./types.js";

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function matchReceipt(
  request: IntakeRetainedRequest,
  receipts: readonly IntakeReceipt[],
): IntakeReceipt | undefined {
  const text = normalizeText(request.requestText);
  return receipts.find((receipt) => {
    if (request.sourceMessageId && receipt.idempotencyKey.includes(request.sourceMessageId)) {
      return normalizeText(receipt.requestText) === text;
    }
    return normalizeText(receipt.requestText) === text;
  });
}

function matchCanonical(
  request: IntakeRetainedRequest,
  receipt: IntakeReceipt | undefined,
  tasks: readonly IntakeCanonicalEvidence[],
): IntakeCanonicalEvidence | undefined {
  if (receipt?.canonicalTaskId) {
    const byId = tasks.find((task) => task.id === receipt.canonicalTaskId);
    if (byId) {
      return byId;
    }
  }
  const text = normalizeText(request.requestText);
  return tasks.find(
    (task) =>
      normalizeText(task.requestText) === text ||
      normalizeText(task.title) === text ||
      (receipt?.canonicalTaskId && task.id === receipt.canonicalTaskId),
  );
}

export function auditCanonicalCoverage(params: {
  retainedRequests: readonly IntakeRetainedRequest[];
  canonicalTasks: readonly IntakeCanonicalEvidence[];
  receipts: readonly IntakeReceipt[];
  coverageBoundary: string;
  retentionLimit?: string;
}): IntakeBackfillFinding[] {
  const findings: IntakeBackfillFinding[] = [];
  for (const request of params.retainedRequests) {
    const requestText = request.requestText.trim();
    if (!requestText) {
      continue;
    }
    const receipt = matchReceipt(request, params.receipts);
    const canonical = matchCanonical(request, receipt, params.canonicalTasks);
    const terminal =
      receipt?.disposition === "created_new" ||
      receipt?.disposition === "linked_existing" ||
      receipt?.disposition === "completed";
    if (terminal && (receipt.canonicalTaskId || receipt.canonicalTaskUrl)) {
      continue;
    }
    if (!receipt && canonical) {
      findings.push({
        requestText,
        confidence: "likely",
        reason: "canonical task evidence exists without a confirmed intake receipt",
        sourceMessageId: request.sourceMessageId,
        sourceTimestampMs: request.sourceTimestampMs,
        canonicalTaskId: canonical.id,
      });
      continue;
    }
    if (receipt && !terminal) {
      findings.push({
        requestText,
        confidence: "proven",
        reason: "retained source request has no confirmed canonical task identity",
        sourceMessageId: request.sourceMessageId,
        sourceTimestampMs: request.sourceTimestampMs,
      });
      continue;
    }
    findings.push({
      requestText,
      confidence: "proven",
      reason: "retained source request is absent from the ledger and canonical task evidence",
      sourceMessageId: request.sourceMessageId,
      sourceTimestampMs: request.sourceTimestampMs,
    });
  }
  if (params.retentionLimit) {
    findings.push({
      requestText: params.coverageBoundary,
      confidence: "unprovable",
      reason: "coverage is bounded by retention limits; missing history cannot be proven",
      retentionLimit: params.retentionLimit,
    });
  }
  return findings;
}
