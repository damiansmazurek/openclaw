import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { acknowledgementMatches, missingAcknowledgementSnippets } from "./ack.js";
import { isImplementationAgent, matchIntakeBoard, type IntakeLedgerConfig } from "./config.js";
import { collectPeerIds, sourceRefFromInbound } from "./privacy.js";
import { IntakeLedgerService } from "./service.js";

const INTAKE_PROMPT = [
  "Intake ledger is the durable owner for MoL Board and other configured request boards.",
  "Before repository analysis or canonical-task lookup, call intake_ledger_record_requests with every atomic actionable request.",
  "Then record exactly one terminal disposition per receipt via intake_ledger_disposition.",
  "created_new, linked_existing, and completed become terminal only after a confirmed canonical task id or url.",
  "An uncertain duplicate match must stay visible as needs_canonical_review with owner and retry deadline.",
  "The natural final reply must include extracted count plus every task link or non-action reason.",
  "Do not store unrelated chat content in tools; send only the request text needed for audit.",
  "Implementation workers must use intake_ledger_canonical_ready only and must not treat unresolved intake as product work.",
].join(" ");

type IntakeMessageReceivedEvent = {
  from?: string;
  metadata?: Record<string, unknown>;
  messageId?: string;
  senderId?: string;
  timestamp?: number;
  sessionKey?: string;
  runId?: string;
};

type IntakeFinalizeEvent = {
  sessionKey?: string;
  lastAssistantMessage?: string;
};

type IntakeMessageSentEvent = {
  content?: string;
  success: boolean;
  messageId?: string;
  sessionKey?: string;
  error?: string;
};

export function peerIdsFromMessage(
  event: IntakeMessageReceivedEvent,
  ctx: { conversationId?: string },
): string[] {
  return collectPeerIds({
    from: event.from,
    conversationId: ctx.conversationId,
    metadata: event.metadata,
  });
}

export function createIntakeLedgerHooks(params: {
  api: Pick<OpenClawPluginApi, "logger">;
  service: IntakeLedgerService;
  config: IntakeLedgerConfig;
}) {
  const { api, service, config } = params;

  return {
    onMessageReceived(
      event: IntakeMessageReceivedEvent,
      ctx: {
        channelId?: string;
        accountId?: string;
        conversationId?: string;
        sessionKey?: string;
        runId?: string;
      },
    ) {
      if (config.boards.length === 0) {
        return;
      }
      const board = matchIntakeBoard(config.boards, {
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        peerIds: peerIdsFromMessage(event, ctx),
      });
      if (!board) {
        return;
      }
      const source = sourceRefFromInbound({
        boardId: board.id,
        channel: ctx.channelId ?? "",
        accountId: ctx.accountId,
        peerId: peerIdsFromMessage(event, ctx)[0],
        messageId: event.messageId,
        senderId: event.senderId,
        sourceTimestampMs: event.timestamp,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
        runId: event.runId ?? ctx.runId,
      });
      if (!source) {
        return;
      }
      service.persistEnvelope(source);
    },

    onBeforePromptBuild(
      _event: unknown,
      ctx: { agentId?: string; sessionKey?: string },
    ): { prependContext: string } | undefined {
      if (isImplementationAgent(config, ctx.agentId)) {
        return {
          prependContext:
            "Use intake_ledger_canonical_ready for created or linked canonical tasks only. Unresolved intake is not product-code work.",
        };
      }
      const envelopes = service.envelopesForSession(ctx.sessionKey);
      if (envelopes.length === 0) {
        return undefined;
      }
      const lines = envelopes.map(
        (envelope) =>
          `envelope ${envelope.id} message ${envelope.messageId} extracted ${envelope.extractedCount} status ${envelope.extractionStatus}`,
      );
      return {
        prependContext: `${INTAKE_PROMPT} Open envelopes in order: ${lines.join("; ")}.`,
      };
    },

    onBeforeToolCall(
      event: { toolName: string },
      ctx: { agentId?: string; sessionKey?: string },
    ): { block: true; blockReason: string } | undefined {
      if (isImplementationAgent(config, ctx.agentId)) {
        return undefined;
      }
      if (event.toolName.startsWith("intake_ledger_")) {
        return undefined;
      }
      const pending = service.pendingExtractionEnvelopes(ctx.sessionKey);
      if (pending.length === 0) {
        return undefined;
      }
      return {
        block: true,
        blockReason: `Record atomic intake receipts with intake_ledger_record_requests before ${event.toolName}. Pending envelopes in order: ${pending.map((envelope) => envelope.id).join(", ")}.`,
      };
    },

    onBeforeAgentFinalize(
      event: IntakeFinalizeEvent,
      ctx: { sessionKey?: string },
    ):
      | {
          action: "revise";
          reason: string;
          retry: { instruction: string; idempotencyKey: string; maxAttempts: number };
        }
      | undefined {
      const envelopes = service.envelopesForSession(event.sessionKey ?? ctx.sessionKey);
      if (envelopes.length === 0) {
        return undefined;
      }
      for (const envelope of envelopes) {
        const completeness = service.completenessOrError(envelope.id);
        if (completeness) {
          return {
            action: "revise",
            reason: completeness.message,
            retry: {
              instruction: `Extracted ${completeness.extractedCount} request(s) but recorded ${completeness.disposedCount} confirmed disposition(s). Record a confirmed terminal disposition, including canonical task identity for created/linked/completed work, before the turn can close.`,
              idempotencyKey: `intake-ledger:finalize:${envelope.id}`,
              maxAttempts: 2,
            },
          };
        }
        const ack = service.acknowledgementFor(envelope.id);
        if (ack && !acknowledgementMatches(event.lastAssistantMessage, ack)) {
          const missing = missingAcknowledgementSnippets(event.lastAssistantMessage, ack);
          return {
            action: "revise",
            reason: "final reply is missing the intake acknowledgement",
            retry: {
              instruction: `Include this exact intake acknowledgement in the natural final reply (missing: ${missing.join("; ")}):\n${ack.text}`,
              idempotencyKey: `intake-ledger:finalize:${envelope.id}`,
              maxAttempts: 2,
            },
          };
        }
      }
      return undefined;
    },

    onAgentEnd(_event: unknown, ctx: { sessionKey?: string; runId?: string }) {
      const envelopes = service.envelopesForSession(ctx.sessionKey);
      for (const envelope of envelopes) {
        const completeness = service.completenessOrError(envelope.id);
        if (completeness) {
          service.store.insertAlert({
            envelopeId: envelope.id,
            kind: "turn_incomplete",
            message: completeness.message,
          });
          continue;
        }
        const closed = service.closeTurn(envelope.id);
        api.logger.info(
          `intake-ledger closed ${closed.envelope.id}: ${closed.acknowledgement.text}`,
        );
      }
    },

    onMessageSent(event: IntakeMessageSentEvent, ctx: { sessionKey?: string; channelId?: string }) {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      for (const envelope of service.envelopesForSession(sessionKey)) {
        const ack = service.acknowledgementFor(envelope.id);
        if (!ack) {
          continue;
        }
        if (event.success && acknowledgementMatches(event.content, ack)) {
          service.settleReplyAck({
            envelopeId: envelope.id,
            success: true,
            remoteId: event.messageId,
          });
          continue;
        }
        if (!event.success) {
          service.settleReplyAck({
            envelopeId: envelope.id,
            success: false,
            error: event.error ?? "message_sent failed",
          });
        }
      }
    },

    onAfterCompaction(_event: unknown, ctx: { sessionKey?: string }) {
      for (const envelope of service.envelopesForSession(ctx.sessionKey)) {
        api.logger.info(
          `intake-ledger receipts survived compaction for envelope ${envelope.id} (${envelope.extractedCount} extracted)`,
        );
      }
    },
  };
}
