import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type, type TProperties } from "typebox";
import { isImplementationAgent, type IntakeLedgerConfig } from "./config.js";
import { sanitizeAtomicRequests } from "./privacy.js";
import { IntakeLedgerService } from "./service.js";
import { INTAKE_BACKFILL_CONFIDENCE, INTAKE_TERMINAL_DISPOSITIONS } from "./types.js";
import type {
  IntakeBackfillFinding,
  IntakeCanonicalEvidence,
  IntakeRetainedRequest,
  IntakeTerminalDisposition,
} from "./types.js";

export const INTAKE_LEDGER_TOOL_NAMES = [
  "intake_ledger_record_requests",
  "intake_ledger_disposition",
  "intake_ledger_audit",
  "intake_ledger_canonical_ready",
  "intake_ledger_ack_delivery",
  "intake_ledger_backfill",
] as const;

export const INTAKE_LEDGER_IMPLEMENTATION_TOOL_NAMES = ["intake_ledger_canonical_ready"] as const;

function strictObject<const Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}

function contextRunId(ctx: OpenClawPluginToolContext | undefined): string | undefined {
  const record = (ctx ?? {}) as Record<string, unknown>;
  return typeof record.runId === "string" ? record.runId : undefined;
}

function readDisposition(value: unknown): IntakeTerminalDisposition {
  const text = readStringParam(value as Record<string, unknown>, "disposition", { required: true });
  if (!(INTAKE_TERMINAL_DISPOSITIONS as readonly string[]).includes(text)) {
    throw new Error(`disposition must be one of ${INTAKE_TERMINAL_DISPOSITIONS.join(", ")}`);
  }
  return text as IntakeTerminalDisposition;
}

function readRetainedRequests(value: unknown): IntakeRetainedRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const requestText = typeof record.requestText === "string" ? record.requestText.trim() : "";
    if (!requestText) {
      return [];
    }
    return [
      {
        requestText,
        sourceTimestampMs:
          typeof record.sourceTimestampMs === "number" ? record.sourceTimestampMs : undefined,
        sourceMessageId:
          typeof record.sourceMessageId === "string" ? record.sourceMessageId : undefined,
      },
    ];
  });
}

function readCanonicalTasks(value: unknown): IntakeCanonicalEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      return [];
    }
    return [
      {
        id,
        url: typeof record.url === "string" ? record.url : undefined,
        requestText: typeof record.requestText === "string" ? record.requestText : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
      },
    ];
  });
}

function readFindings(value: unknown): IntakeBackfillFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const requestText = typeof record.requestText === "string" ? record.requestText.trim() : "";
    const confidence = record.confidence;
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (
      !requestText ||
      !reason ||
      typeof confidence !== "string" ||
      !(INTAKE_BACKFILL_CONFIDENCE as readonly string[]).includes(confidence)
    ) {
      return [];
    }
    return [
      {
        requestText,
        confidence: confidence as IntakeBackfillFinding["confidence"],
        reason,
        sourceTimestampMs:
          typeof record.sourceTimestampMs === "number" ? record.sourceTimestampMs : undefined,
        sourceMessageId:
          typeof record.sourceMessageId === "string" ? record.sourceMessageId : undefined,
        retentionLimit:
          typeof record.retentionLimit === "string" ? record.retentionLimit : undefined,
        canonicalTaskId:
          typeof record.canonicalTaskId === "string" ? record.canonicalTaskId : undefined,
      },
    ];
  });
}

export function createIntakeLedgerTools(params: {
  context?: OpenClawPluginToolContext;
  service: IntakeLedgerService;
  config: IntakeLedgerConfig;
}): AnyAgentTool[] {
  const { service, config } = params;
  const canonicalReady: AnyAgentTool = {
    name: "intake_ledger_canonical_ready",
    label: "Intake Canonical Ready",
    description:
      "List created or linked canonical tasks that implementation workers may process. Unresolved intake is never returned.",
    parameters: strictObject({
      boardId: Type.Optional(Type.String({ description: "Optional intake board id." })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const record = rawParams as Record<string, unknown>;
      const boardId =
        typeof record.boardId === "string" && record.boardId.trim()
          ? record.boardId.trim()
          : undefined;
      const receipts = service
        .canonicalReady(boardId)
        .filter(
          (receipt) =>
            receipt.disposition === "created_new" || receipt.disposition === "linked_existing",
        );
      return jsonResult({
        tasks: receipts.map((receipt) => ({
          receiptId: receipt.id,
          disposition: receipt.disposition,
          canonicalTaskId: receipt.canonicalTaskId,
          canonicalTaskUrl: receipt.canonicalTaskUrl,
          requestText: receipt.requestText,
        })),
      });
    },
  };

  if (isImplementationAgent(config, params.context?.agentId)) {
    return [canonicalReady];
  }

  return [
    {
      name: "intake_ledger_record_requests",
      label: "Intake Record Requests",
      description:
        "Persist atomic request receipts for an inbound envelope before canonical lookup or Notion writes. Replays are idempotent.",
      parameters: strictObject({
        envelopeId: Type.Optional(
          Type.String({ description: "Envelope id from the current inbound message." }),
        ),
        requests: Type.Array(
          Type.Object(
            {
              requestIndex: Type.Optional(Type.Integer({ minimum: 0 })),
              requestText: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
          ),
          { description: "Atomic actionable requests extracted from the inbound message." },
        ),
        turnId: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const envelopeId =
          readStringParam(record, "envelopeId") ??
          service.latestEnvelopeForSession(params.context?.sessionKey)?.id;
        if (!envelopeId) {
          throw new Error(
            "envelopeId is required when no inbound intake envelope is bound to this session",
          );
        }
        const result = service.recordRequests({
          envelopeId,
          requests: sanitizeAtomicRequests(record.requests),
          turnId: readStringParam(record, "turnId") ?? contextRunId(params.context),
        });
        return jsonResult({
          envelopeId: result.envelope.id,
          extractedCount: result.envelope.extractedCount,
          created: result.created,
          receipts: result.receipts.map((receipt) => ({
            id: receipt.id,
            idempotencyKey: receipt.idempotencyKey,
            requestIndex: receipt.requestIndex,
            requestText: receipt.requestText,
            disposition: receipt.disposition ?? null,
          })),
        });
      },
    },
    {
      name: "intake_ledger_disposition",
      label: "Intake Disposition",
      description:
        "Record one disposition per receipt. created_new/linked_existing/completed are terminal only after a confirmed canonical task id or url. needs_canonical_review requires owner and deadline. not_actioned requires a reason.",
      parameters: strictObject({
        idempotencyKey: Type.Optional(Type.String()),
        envelopeId: Type.Optional(Type.String()),
        requestIndex: Type.Optional(Type.Integer({ minimum: 0 })),
        disposition: Type.String({
          description: INTAKE_TERMINAL_DISPOSITIONS.join(", "),
        }),
        reason: Type.Optional(Type.String()),
        canonicalTaskId: Type.Optional(Type.String()),
        canonicalTaskUrl: Type.Optional(Type.String()),
        reviewOwner: Type.Optional(Type.String()),
        reviewDeadlineMs: Type.Optional(Type.Integer()),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const result = service.recordDisposition({
          idempotencyKey: readStringParam(record, "idempotencyKey"),
          envelopeId: readStringParam(record, "envelopeId"),
          requestIndex:
            typeof record.requestIndex === "number" && Number.isInteger(record.requestIndex)
              ? record.requestIndex
              : undefined,
          disposition: readDisposition(record),
          reason: readStringParam(record, "reason"),
          canonicalTaskId: readStringParam(record, "canonicalTaskId"),
          canonicalTaskUrl: readStringParam(record, "canonicalTaskUrl"),
          reviewOwner: readStringParam(record, "reviewOwner"),
          reviewDeadlineMs:
            typeof record.reviewDeadlineMs === "number" ? record.reviewDeadlineMs : undefined,
          turnId: contextRunId(params.context),
        });
        return jsonResult({
          receipt: {
            id: result.receipt.id,
            idempotencyKey: result.receipt.idempotencyKey,
            disposition: result.receipt.disposition,
            reason: result.receipt.dispositionReason ?? null,
            canonicalTaskId: result.receipt.canonicalTaskId ?? null,
            canonicalTaskUrl: result.receipt.canonicalTaskUrl ?? null,
          },
          replayed: result.replayed,
          pendingRemote: result.pendingRemote,
        });
      },
    },
    {
      name: "intake_ledger_audit",
      label: "Intake Audit",
      description:
        "List unresolved intake entries with source timestamps and reasons, including reviewable ambiguous matches and undelivered outbox items.",
      parameters: strictObject({
        olderThanMs: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const olderThanMs =
          typeof record.olderThanMs === "number" && Number.isFinite(record.olderThanMs)
            ? Math.max(0, Math.trunc(record.olderThanMs))
            : undefined;
        return jsonResult(service.audit({ olderThanMs }));
      },
    },
    canonicalReady,
    {
      name: "intake_ledger_ack_delivery",
      label: "Intake Ack Delivery",
      description:
        "Complete a claimed Notion or acknowledgement outbox item after a confirmed side effect. Requires the current claim token for in-flight rows.",
      parameters: strictObject({
        idempotencyKey: Type.String({ minLength: 1 }),
        remoteId: Type.Optional(Type.String()),
        claimToken: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const idempotencyKey = readStringParam(record, "idempotencyKey", { required: true });
        const item = service.ackDelivery(
          idempotencyKey,
          readStringParam(record, "remoteId"),
          readStringParam(record, "claimToken"),
        );
        if (!item) {
          throw new Error(`outbox item not found: ${idempotencyKey}`);
        }
        return jsonResult({
          id: item.id,
          status: item.status,
          kind: item.kind,
        });
      },
    },
    {
      name: "intake_ledger_backfill",
      label: "Intake Backfill",
      description:
        "Audit retained source requests against canonical task evidence. Derives confirmed gaps vs likely/unprovable retention limits; does not store unrelated chat.",
      parameters: strictObject({
        boardId: Type.String({ minLength: 1 }),
        coverageBoundary: Type.String({ minLength: 1 }),
        retentionLimit: Type.Optional(Type.String()),
        retainedRequests: Type.Optional(
          Type.Array(
            Type.Object(
              {
                requestText: Type.String({ minLength: 1 }),
                sourceTimestampMs: Type.Optional(Type.Integer()),
                sourceMessageId: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        ),
        canonicalTasks: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.String({ minLength: 1 }),
                url: Type.Optional(Type.String()),
                requestText: Type.Optional(Type.String()),
                title: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        ),
        findings: Type.Optional(
          Type.Array(
            Type.Object(
              {
                requestText: Type.String({ minLength: 1 }),
                confidence: Type.String(),
                reason: Type.String({ minLength: 1 }),
                sourceTimestampMs: Type.Optional(Type.Integer()),
                sourceMessageId: Type.Optional(Type.String()),
                retentionLimit: Type.Optional(Type.String()),
                canonicalTaskId: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        ),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const run = service.recordBackfill({
          boardId: readStringParam(record, "boardId", { required: true }),
          coverageBoundary: readStringParam(record, "coverageBoundary", { required: true }),
          retentionLimit: readStringParam(record, "retentionLimit"),
          retainedRequests: readRetainedRequests(record.retainedRequests),
          canonicalTasks: readCanonicalTasks(record.canonicalTasks),
          findings: readFindings(record.findings),
        });
        return jsonResult({
          id: run.id,
          provenCount: run.provenCount,
          likelyCount: run.likelyCount,
          unprovableCount: run.unprovableCount,
          coverageBoundary: run.coverageBoundary,
        });
      },
    },
  ];
}
