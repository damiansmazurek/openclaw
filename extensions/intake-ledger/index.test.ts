import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { createIntakeFixture } from "./src/test-harness.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("intake ledger plugin registration", () => {
  it("registers tools, CLI, hooks, and a startup reconciler without optional tool flags", () => {
    const { dir } = createIntakeFixture();
    process.env.OPENCLAW_STATE_DIR = dir;
    const events: string[] = [];
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
          on(event, handler, opts) {
            events.push(event);
            return api.on(event, handler, opts);
          },
          registerTool(tool, opts) {
            toolOpts.push(opts);
            api.registerTool(tool, opts);
          },
        });
      },
    });
    expect(captured.cliRegistrars.length).toBe(1);
    expect(captured.runtimeLifecycles.map((entry) => entry.id)).toContain("intake-ledger-store");
    expect(events).toEqual(
      expect.arrayContaining([
        "message_received",
        "before_tool_call",
        "before_agent_finalize",
        "agent_end",
        "message_sent",
      ]),
    );
    expect((toolOpts[0] as { optional?: boolean } | undefined)?.optional).toBeUndefined();
    void captured.runtimeLifecycles
      .find((entry) => entry.id === "intake-ledger-store")
      ?.dispose?.();
  });
});
