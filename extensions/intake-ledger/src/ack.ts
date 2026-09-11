import type { IntakeEnvelope, IntakeReceipt } from "./types.js";

export type IntakeAcknowledgement = {
  text: string;
  extractedCount: number;
  requiredSnippets: string[];
};

export function buildAcknowledgement(params: {
  envelope: IntakeEnvelope;
  receipts: IntakeReceipt[];
}): IntakeAcknowledgement {
  const requiredSnippets = [
    `Intake batch ${params.envelope.messageId}`,
    `extracted ${params.envelope.extractedCount}`,
  ];
  const lines = [
    `Intake batch ${params.envelope.messageId}: extracted ${params.receipts.length} atomic request(s).`,
  ];
  if (params.receipts.length === 0) {
    lines.push("No actionable requests were extracted.");
    return {
      text: lines.join("\n"),
      extractedCount: 0,
      requiredSnippets: [...requiredSnippets, "No actionable requests were extracted."],
    };
  }
  for (const receipt of params.receipts) {
    const task = receipt.canonicalTaskUrl ?? receipt.canonicalTaskId;
    const reason = receipt.dispositionReason ? ` — ${receipt.dispositionReason}` : "";
    const taskRef = task ? ` (${task})` : "";
    const review =
      receipt.disposition === "needs_canonical_review" ||
      receipt.requestedDisposition === "needs_canonical_review"
        ? ` owner=${receipt.reviewOwner ?? "unassigned"} deadline=${receipt.reviewDeadlineMs ?? "none"}`
        : "";
    lines.push(
      `${receipt.requestIndex + 1}. ${receipt.disposition ?? receipt.requestedDisposition ?? "undisposed"}${taskRef}${reason}${review}`,
    );
    if (task) {
      requiredSnippets.push(task);
    }
    if (receipt.dispositionReason) {
      requiredSnippets.push(receipt.dispositionReason);
    }
    if (
      receipt.disposition === "needs_canonical_review" ||
      receipt.requestedDisposition === "needs_canonical_review"
    ) {
      if (receipt.reviewOwner) {
        requiredSnippets.push(receipt.reviewOwner);
      }
      if (receipt.reviewDeadlineMs) {
        requiredSnippets.push(String(receipt.reviewDeadlineMs));
      }
    }
  }
  const missing = params.receipts.filter((receipt) => !receipt.disposition).length;
  if (missing > 0) {
    lines.push(`${missing} atomic request(s) still have no terminal disposition.`);
  }
  return {
    text: lines.join("\n"),
    extractedCount: params.envelope.extractedCount,
    requiredSnippets,
  };
}

export function acknowledgementMatches(
  text: string | undefined,
  ack: IntakeAcknowledgement,
): boolean {
  if (!text) {
    return false;
  }
  return ack.requiredSnippets.every((snippet) => text.includes(snippet));
}

export function missingAcknowledgementSnippets(
  text: string | undefined,
  ack: IntakeAcknowledgement,
): string[] {
  if (!text) {
    return [...ack.requiredSnippets];
  }
  return ack.requiredSnippets.filter((snippet) => !text.includes(snippet));
}
