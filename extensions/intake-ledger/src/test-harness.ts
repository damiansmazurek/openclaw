import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach } from "vitest";
import type { IntakeDeliveryAdapter } from "./adapters.js";
import { resolveIntakeLedgerConfig, type IntakeLedgerConfig } from "./config.js";
import { IntakeLedgerService } from "./service.js";
import { IntakeLedgerStore } from "./store.js";
import type { IntakeAtomicRequest, IntakeSourceRef } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export function createIntakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    set: (value: number) => {
      now = value;
    },
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

export function createIntakeFixture(params?: {
  now?: () => number;
  config?: unknown;
  adapters?: IntakeDeliveryAdapter[];
}) {
  const dir = tempDirs.make("intake-ledger-");
  const store = new IntakeLedgerStore(dir, params?.now);
  const config: IntakeLedgerConfig = resolveIntakeLedgerConfig(
    params?.config ?? {
      boards: [
        {
          id: "mol-board",
          channel: "whatsapp",
          peerIds: ["mol-board@g.us"],
          notionDataSourceId: "373d88e5-c7fc-80ec-8b85-f1c89a0bd2f4",
          unresolvedAlertAfterMs: 60_000,
        },
      ],
      implementationAgentIds: ["jarvis-mol-v2-worker"],
    },
  );
  const service = new IntakeLedgerService(store, config, params?.adapters ?? []);
  return { dir, store, service, config };
}

export function sampleSource(overrides: Partial<IntakeSourceRef> = {}): IntakeSourceRef {
  return {
    boardId: "mol-board",
    channel: "whatsapp",
    peerId: "mol-board@g.us",
    messageId: "3BD6DCADA2836AC6FE60",
    senderId: "benoit",
    sourceTimestampMs: 1_700_000_000_000,
    sessionKey: "agent:main:whatsapp:mol-board",
    runId: "run-1",
    ...overrides,
  };
}

export function tenRequests(): IntakeAtomicRequest[] {
  return Array.from({ length: 10 }, (_, index) => ({
    requestIndex: index,
    requestText: `Atomic request ${index + 1}`,
  }));
}
