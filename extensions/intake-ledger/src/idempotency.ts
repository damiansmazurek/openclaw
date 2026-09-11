export function buildIntakeIdempotencyKey(params: {
  channel: string;
  messageId: string;
  requestIndex: number;
}): string {
  return `${params.channel}:${params.messageId}:${params.requestIndex}`;
}

export function parseIntakeIdempotencyKey(
  key: string,
): { channel: string; messageId: string; requestIndex: number } | undefined {
  const lastColon = key.lastIndexOf(":");
  if (lastColon <= 0) {
    return undefined;
  }
  const requestIndex = Number(key.slice(lastColon + 1));
  if (!Number.isInteger(requestIndex) || requestIndex < 0) {
    return undefined;
  }
  const rest = key.slice(0, lastColon);
  const firstColon = rest.indexOf(":");
  if (firstColon <= 0 || firstColon === rest.length - 1) {
    return undefined;
  }
  return {
    channel: rest.slice(0, firstColon),
    messageId: rest.slice(firstColon + 1),
    requestIndex,
  };
}

export function buildOutboxIdempotencyKey(params: {
  kind: string;
  receiptId?: string;
  envelopeId?: string;
  alertId?: string;
}): string {
  if (params.kind === "alert" && params.alertId) {
    return `alert:${params.alertId}`;
  }
  return `${params.kind}:${params.receiptId ?? params.envelopeId ?? "none"}`;
}
