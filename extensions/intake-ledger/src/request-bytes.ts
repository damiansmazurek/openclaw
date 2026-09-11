import type { IntakeAtomicRequest } from "./types.js";

export const MAX_REQUEST_TEXT_CHARS = 4000;

export class IntakeRequestAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeRequestAdmissionError";
  }
}

export function admitRequestText(value: unknown): string {
  if (typeof value !== "string") {
    throw new IntakeRequestAdmissionError("request text must be a string");
  }
  if (value.trim().length === 0) {
    throw new IntakeRequestAdmissionError("request text must not be whitespace-only");
  }
  if (value.length > MAX_REQUEST_TEXT_CHARS) {
    throw new IntakeRequestAdmissionError(
      `request text exceeds the supported ${MAX_REQUEST_TEXT_CHARS}-character bound`,
    );
  }
  return value;
}

export function admitAtomicRequests(value: unknown): IntakeAtomicRequest[] {
  if (!Array.isArray(value)) {
    throw new IntakeRequestAdmissionError("requests must be an array");
  }
  const requests: IntakeAtomicRequest[] = [];
  const seen = new Set<number>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new IntakeRequestAdmissionError(`requests[${index}] is malformed`);
    }
    const record = entry as Record<string, unknown>;
    const rawIndex = record.requestIndex;
    const requestIndex =
      rawIndex === undefined
        ? index
        : typeof rawIndex === "number" && Number.isInteger(rawIndex)
          ? rawIndex
          : Number.NaN;
    if (!Number.isInteger(requestIndex) || requestIndex < 0) {
      throw new IntakeRequestAdmissionError(
        `requestIndex must be a unique nonnegative integer: ${String(rawIndex)}`,
      );
    }
    if (seen.has(requestIndex)) {
      throw new IntakeRequestAdmissionError(`duplicate requestIndex ${requestIndex}`);
    }
    seen.add(requestIndex);
    const requestText = admitRequestText(record.requestText ?? record.text);
    requests.push({ requestIndex, requestText });
  }
  return requests;
}

export function requestSetFingerprint(
  requests: readonly Pick<IntakeAtomicRequest, "requestIndex" | "requestText">[],
): string {
  return JSON.stringify(
    [...requests]
      .map((request) => [request.requestIndex, request.requestText] as const)
      .sort((left, right) => left[0] - right[0]),
  );
}
