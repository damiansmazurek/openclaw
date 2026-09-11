import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_INTAKE_OWNER_AGENT_ID } from "./agent-access.js";

export type IntakeBoardConfig = {
  id: string;
  channel: string;
  accountId?: string;
  peerIds: string[];
  notionDataSourceId?: string;
  automationJobId?: string;
  unresolvedAlertAfterMs: number;
};

export type IntakeLedgerConfig = {
  boards: IntakeBoardConfig[];
  intakeOwnerAgentIds: string[];
  automationAgentIds: string[];
  implementationAgentIds: string[];
  reconcileIntervalMs: number;
  inFlightTimeoutMs: number;
  automationJobId?: string;
};

const DEFAULT_UNRESOLVED_ALERT_MS = 60 * 60 * 1000;
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 5 * 60 * 1000;

function clampPositive(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  for (const entry of value) {
    const text = normalizeOptionalString(entry);
    if (text && !items.includes(text)) {
      items.push(text);
    }
  }
  return items;
}

function readBoard(value: unknown): IntakeBoardConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const channel = normalizeOptionalString(record.channel);
  if (!id || !channel) {
    return undefined;
  }
  return {
    id,
    channel,
    accountId: normalizeOptionalString(record.accountId),
    peerIds: readStringList(record.peerIds),
    notionDataSourceId: normalizeOptionalString(record.notionDataSourceId),
    automationJobId: normalizeOptionalString(record.automationJobId),
    unresolvedAlertAfterMs: clampPositive(
      record.unresolvedAlertAfterMs,
      DEFAULT_UNRESOLVED_ALERT_MS,
      1000,
      7 * 24 * 60 * 60 * 1000,
    ),
  };
}

export function resolveIntakeLedgerConfig(raw: unknown): IntakeLedgerConfig {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const boards = Array.isArray(value.boards)
    ? value.boards.flatMap((entry) => {
        const board = readBoard(entry);
        return board ? [board] : [];
      })
    : [];
  const intakeOwnerAgentIds = readStringList(value.intakeOwnerAgentIds);
  return {
    boards,
    intakeOwnerAgentIds:
      intakeOwnerAgentIds.length > 0 ? intakeOwnerAgentIds : [DEFAULT_INTAKE_OWNER_AGENT_ID],
    automationAgentIds: readStringList(value.automationAgentIds),
    implementationAgentIds: readStringList(value.implementationAgentIds),
    automationJobId: normalizeOptionalString(value.automationJobId),
    reconcileIntervalMs: clampPositive(
      value.reconcileIntervalMs,
      DEFAULT_RECONCILE_INTERVAL_MS,
      1000,
      60 * 60 * 1000,
    ),
    inFlightTimeoutMs: clampPositive(
      value.inFlightTimeoutMs,
      DEFAULT_IN_FLIGHT_TIMEOUT_MS,
      1000,
      60 * 60 * 1000,
    ),
  };
}

export function matchIntakeBoard(
  boards: readonly IntakeBoardConfig[],
  params: {
    channelId?: string;
    accountId?: string;
    peerIds: string[];
  },
): IntakeBoardConfig | undefined {
  const channel = normalizeOptionalString(params.channelId);
  if (!channel) {
    return undefined;
  }
  return boards.find((board) => {
    if (board.channel !== channel) {
      return false;
    }
    if (board.accountId && board.accountId !== params.accountId) {
      return false;
    }
    if (board.peerIds.length === 0) {
      return true;
    }
    return params.peerIds.some((peerId) => board.peerIds.includes(peerId));
  });
}

export function isImplementationAgent(
  config: IntakeLedgerConfig,
  agentId: string | undefined,
): boolean {
  const id = normalizeOptionalString(agentId);
  return Boolean(id && config.implementationAgentIds.includes(id));
}

export function boardAutomationJobId(
  config: IntakeLedgerConfig,
  boardId: string,
): string | undefined {
  const board = config.boards.find((entry) => entry.id === boardId);
  return board?.automationJobId ?? config.automationJobId;
}
