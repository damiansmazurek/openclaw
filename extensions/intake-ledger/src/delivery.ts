import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { IntakeDeliveryAdapter } from "./adapters.js";
import { boardAutomationJobId, type IntakeLedgerConfig } from "./config.js";
import { redactPersistedError } from "./privacy.js";
import type { IntakeDeliveryResult, IntakeOutboxItem } from "./types.js";

export type IntakeBoardSendParams = {
  channel: string;
  accountId?: string;
  to: string;
  text: string;
};

export type IntakeDeliveryRuntime = {
  sendBoardText?: (params: IntakeBoardSendParams) => Promise<{ messageId?: string }>;
  runCronJob?: (jobId: string) => Promise<{ ran?: boolean; reason?: string; runId?: string }>;
};

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function routingFromItem(item: IntakeOutboxItem): IntakeBoardSendParams | undefined {
  const channel = payloadString(item.payload, "channel");
  const to = payloadString(item.payload, "peerId");
  const text = payloadString(item.payload, "text") ?? payloadString(item.payload, "message");
  if (!channel || !to || !text) {
    return undefined;
  }
  return {
    channel,
    accountId: payloadString(item.payload, "accountId"),
    to,
    text,
  };
}

async function deliverBoardText(params: {
  item: IntakeOutboxItem;
  runtime: IntakeDeliveryRuntime;
}): Promise<IntakeDeliveryResult> {
  const routing = routingFromItem(params.item);
  if (!routing) {
    return {
      ok: false,
      error: `missing durable routing facts for ${params.item.kind}`,
      retryable: false,
    };
  }
  if (!params.runtime.sendBoardText) {
    return {
      ok: false,
      error: `no outbound runtime registered for ${params.item.kind}`,
      retryable: false,
    };
  }
  try {
    const sent = await params.runtime.sendBoardText(routing);
    return { ok: true, remoteId: sent.messageId };
  } catch (error) {
    return { ok: false, error: redactPersistedError(error), retryable: true };
  }
}

async function deliverNotionHandoff(params: {
  item: IntakeOutboxItem;
  config: IntakeLedgerConfig;
  runtime: IntakeDeliveryRuntime;
}): Promise<IntakeDeliveryResult> {
  const boardId = payloadString(params.item.payload, "boardId");
  if (!boardId) {
    return { ok: false, error: "notion outbox is missing boardId", retryable: false };
  }
  const jobId = boardAutomationJobId(params.config, boardId);
  if (!jobId) {
    return {
      ok: false,
      error: `notion automation job is not configured for board ${boardId}`,
      retryable: false,
    };
  }
  if (!params.runtime.runCronJob) {
    return {
      ok: false,
      error: `no Gateway cron owner available to nudge job ${jobId}`,
      retryable: false,
    };
  }
  try {
    const result = await params.runtime.runCronJob(jobId);
    if (result.ran === false) {
      return {
        ok: false,
        error: `notion automation job ${jobId} ${result.reason ?? "not-run"}`,
        retryable: false,
      };
    }
    return {
      ok: false,
      awaitingExternal: true,
      error: `awaiting automation job ${jobId} to claim/complete ${params.item.idempotencyKey}`,
    };
  } catch (error) {
    return { ok: false, error: redactPersistedError(error), retryable: true };
  }
}

export function createProductionDeliveryAdapters(params: {
  config: IntakeLedgerConfig;
  runtime?: IntakeDeliveryRuntime;
}): IntakeDeliveryAdapter[] {
  const runtime = params.runtime ?? {};
  const boardKinds = ["reply_ack", "alert"] as const;
  const notionKinds = ["notion_create", "notion_link", "notion_update"] as const;
  return [
    ...boardKinds.map((kind): IntakeDeliveryAdapter => ({
      kind,
      deliver: (item) => deliverBoardText({ item, runtime }),
    })),
    ...notionKinds.map((kind): IntakeDeliveryAdapter => ({
      kind,
      deliver: (item) => deliverNotionHandoff({ item, config: params.config, runtime }),
    })),
  ];
}

export function cronRunResult(value: unknown): { ran?: boolean; reason?: string; runId?: string } {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ran: typeof value.ran === "boolean" ? value.ran : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
  };
}
