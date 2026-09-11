import type { IntakeDeliveryResult, IntakeOutboxItem } from "./types.js";

export type IntakeDeliveryAdapter = {
  kind: IntakeOutboxItem["kind"];
  deliver(item: IntakeOutboxItem): Promise<IntakeDeliveryResult>;
};

export function createRecordingAdapter(params: {
  kind: IntakeOutboxItem["kind"];
  deliver?: (item: IntakeOutboxItem) => Promise<IntakeDeliveryResult> | IntakeDeliveryResult;
}): IntakeDeliveryAdapter & { deliveries: IntakeOutboxItem[] } {
  const deliveries: IntakeOutboxItem[] = [];
  return {
    kind: params.kind,
    deliveries,
    async deliver(item) {
      deliveries.push(item);
      if (!params.deliver) {
        return { ok: true, remoteId: `recorded:${item.id}` };
      }
      return await params.deliver(item);
    },
  };
}

export function createFailingAdapter(params: {
  kind: IntakeOutboxItem["kind"];
  error: string;
  retryable?: boolean;
}): IntakeDeliveryAdapter {
  return {
    kind: params.kind,
    async deliver() {
      return { ok: false, error: params.error, retryable: params.retryable !== false };
    },
  };
}

export async function deliverOutboxItem(params: {
  item: IntakeOutboxItem;
  adapters: readonly IntakeDeliveryAdapter[];
}): Promise<IntakeDeliveryResult> {
  const adapter = params.adapters.find((entry) => entry.kind === params.item.kind);
  if (!adapter) {
    return {
      ok: false,
      error: `no delivery adapter registered for ${params.item.kind}`,
      retryable: false,
    };
  }
  return await adapter.deliver(params.item);
}
