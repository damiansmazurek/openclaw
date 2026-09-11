import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../index.js";
import { acknowledgementMatches } from "./ack.js";
import { createIntakeLedgerHooks } from "./plugin-hooks.js";
import { createIntakeFixture, sampleSource } from "./test-harness.js";
import { createIntakeLedgerTools } from "./tools.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("intake ledger registered plugin flow", () => {
  it("registers required tools without optional flags", () => {
    const { dir } = createIntakeFixture();
    process.env.OPENCLAW_STATE_DIR = dir;
    const toolOpts: unknown[] = [];
    const captured = capturePluginRegistration({
      id: "intake-ledger",
      name: "Intake Ledger",
      register(api) {
        plugin.register({
          ...api,
          pluginConfig: {
            boards: [{ id: "mol-board", channel: "whatsapp", peerIds: ["mol-board@g.us"] }],
          },
          registerTool(tool, opts) {
            toolOpts.push(opts);
            api.registerTool(tool, opts);
          },
        });
      },
    });
    expect(toolOpts).toEqual([
      expect.objectContaining({
        names: expect.arrayContaining([
          "intake_ledger_record_requests",
          "intake_ledger_disposition",
        ]),
      }),
    ]);
    expect(
      toolOpts.some((opts) => Boolean((opts as { optional?: boolean } | undefined)?.optional)),
    ).toBe(false);
    void captured.runtimeLifecycles
      .find((entry) => entry.id === "intake-ledger-store")
      ?.dispose?.();
  });

  it("walks message_received through receipt gate, disposition, ack, and message_sent", async () => {
    const { service, config, dir } = createIntakeFixture();
    process.env.OPENCLAW_STATE_DIR = dir;
    const hooks = createIntakeLedgerHooks({
      api: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      service,
      config,
    });
    hooks.onMessageReceived(
      {
        from: "mol-board@g.us",
        messageId: "flow-1",
        senderId: "benoit",
        timestamp: 1_700_000_000_000,
        sessionKey: sampleSource().sessionKey,
        runId: "run-flow",
      },
      { channelId: "whatsapp", sessionKey: sampleSource().sessionKey, runId: "run-flow" },
    );
    const envelope = service.latestEnvelopeForSession(sampleSource().sessionKey);
    expect(envelope?.messageId).toBe("flow-1");
    expect(
      hooks.onBeforeToolCall({ toolName: "read" }, { sessionKey: sampleSource().sessionKey })
        ?.block,
    ).toBe(true);
    const tools = createIntakeLedgerTools({
      service,
      config,
      context: { sessionKey: sampleSource().sessionKey, agentId: "main" } as never,
    });
    await tools
      .find((tool) => tool.name === "intake_ledger_record_requests")!
      .execute("c1", {
        requests: [
          { requestIndex: 0, requestText: "Create NPC editor" },
          { requestIndex: 1, requestText: "Withdrawn status check" },
        ],
      });
    expect(
      hooks.onBeforeToolCall({ toolName: "read" }, { sessionKey: sampleSource().sessionKey }),
    ).toBeUndefined();
    const disposition = tools.find((tool) => tool.name === "intake_ledger_disposition")!;
    await disposition.execute("c2", {
      envelopeId: envelope!.id,
      requestIndex: 0,
      disposition: "created_new",
      canonicalTaskId: "task-npc",
      canonicalTaskUrl: "https://notion.so/task-npc",
    });
    await disposition.execute("c3", {
      envelopeId: envelope!.id,
      requestIndex: 1,
      disposition: "not_actioned",
      reason: "withdrawn by requester",
    });
    expect(
      hooks.onBeforeAgentFinalize(
        { sessionKey: sampleSource().sessionKey, lastAssistantMessage: "ok" },
        { sessionKey: sampleSource().sessionKey },
      )?.action,
    ).toBe("revise");
    const ack = service.acknowledgementFor(envelope!.id);
    expect(ack).toBeTruthy();
    expect(
      hooks.onBeforeAgentFinalize(
        { sessionKey: sampleSource().sessionKey, lastAssistantMessage: ack!.text },
        { sessionKey: sampleSource().sessionKey },
      ),
    ).toBeUndefined();
    hooks.onAgentEnd({}, { sessionKey: sampleSource().sessionKey });
    hooks.onMessageSent(
      {
        success: true,
        content: ack!.text,
        messageId: "wa-ack",
        sessionKey: sampleSource().sessionKey,
      },
      { sessionKey: sampleSource().sessionKey, channelId: "whatsapp" },
    );
    const reply = service.store
      .listOutboxForEnvelope(envelope!.id)
      .find((item) => item.kind === "reply_ack");
    expect(reply?.status).toBe("delivered");
    expect(acknowledgementMatches(ack!.text, ack!)).toBe(true);
  });
});
