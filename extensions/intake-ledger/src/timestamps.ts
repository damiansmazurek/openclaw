const EPOCH_SECONDS_UPPER_BOUND = 1e11;

export function normalizeSourceTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  // WhatsApp and some channel paths supply epoch seconds (e.g. 1710000000);
  // other inbound hooks supply epoch milliseconds.
  const normalized = value < EPOCH_SECONDS_UPPER_BOUND ? value * 1000 : value;
  return Math.round(normalized);
}
