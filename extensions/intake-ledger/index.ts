import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "./api.js";
import { resolveIntakeLedgerConfig, type IntakeLedgerConfig } from "./src/config.js";
import { cronRunResult, createProductionDeliveryAdapters } from "./src/delivery.js";
import { createIntakeLedgerHooks } from "./src/plugin-hooks.js";
import { IntakeLedgerService } from "./src/service.js";
import { IntakeLedgerStore } from "./src/store.js";
import { createIntakeLedgerTools, INTAKE_LEDGER_TOOL_NAMES } from "./src/tools.js";

const intakeConfigSchema = {
  parse(value: unknown) {
    return resolveIntakeLedgerConfig(value);
  },
};

export default definePluginEntry({
  id: "intake-ledger",
  name: "Intake Ledger",
  description:
    "Durable request-intake ledger with atomic receipts, explicit dispositions, outbox retry, and unresolved-request reconciliation.",
  configSchema: intakeConfigSchema,
  register(api: OpenClawPluginApi) {
    const config: IntakeLedgerConfig = intakeConfigSchema.parse(api.pluginConfig);
    const store = IntakeLedgerStore.open();
    const adapters = createProductionDeliveryAdapters({
      config,
      runtime: {
        sendBoardText: async ({ channel, accountId, to, text }) => {
          const adapter = await api.runtime.channel.outbound.loadAdapter(channel);
          if (!adapter?.sendText) {
            throw new Error(`outbound adapter for ${channel} is not available`);
          }
          const result = await adapter.sendText({
            cfg: api.config,
            to,
            text,
            ...(accountId ? { accountId } : {}),
          });
          return { messageId: result.messageId };
        },
        runCronJob: async (jobId) => {
          const result = await api.runtime.gateway.request(
            "cron.run",
            { id: jobId, mode: "if-enabled" },
            { scopes: ["operator.admin"] },
          );
          return cronRunResult(result);
        },
      },
    });
    const service = new IntakeLedgerService(store, config, adapters);
    const hooks = createIntakeLedgerHooks({ api, service, config });
    let reconcileTimer: ReturnType<typeof setInterval> | undefined;

    const stopTimer = () => {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = undefined;
      }
    };

    const dispose = () => {
      stopTimer();
      store.close();
    };

    api.registerService({
      id: "intake-ledger",
      start: () => {
        stopTimer();
        reconcileTimer = setInterval(() => {
          void service.reconcile();
        }, config.reconcileIntervalMs);
        reconcileTimer.unref?.();
      },
      stop: stopTimer,
    });

    api.lifecycle.registerRuntimeLifecycle({
      id: "intake-ledger-store",
      dispose,
      cleanup: ({ reason, sessionKey, runId }) => {
        if (
          sessionKey === undefined &&
          runId === undefined &&
          (reason === "restart" || reason === "disable")
        ) {
          dispose();
        }
        return undefined;
      },
    });

    api.registerTool((context) => createIntakeLedgerTools({ context, service, config }), {
      names: [...INTAKE_LEDGER_TOOL_NAMES],
    });

    api.registerCli(
      async ({ program }) => {
        const { registerIntakeLedgerCli } = await import("./src/cli.js");
        registerIntakeLedgerCli({ program, store, config, adapters });
      },
      {
        descriptors: [
          {
            name: "intake-ledger",
            description: "Inspect, reconcile, and audit the request-intake ledger",
            hasSubcommands: true,
          },
        ],
      },
    );

    api.on("message_received", (event, ctx) => {
      hooks.onMessageReceived(event, ctx);
    });

    api.on("before_prompt_build", (event, ctx) => hooks.onBeforePromptBuild(event, ctx));

    api.on("before_tool_call", (event, ctx) => hooks.onBeforeToolCall(event, ctx));

    api.on("before_agent_finalize", (event, ctx) => hooks.onBeforeAgentFinalize(event, ctx));

    api.on("agent_end", (event, ctx) => {
      hooks.onAgentEnd(event, ctx);
    });

    api.on("message_sent", (event, ctx) => {
      hooks.onMessageSent(event, ctx);
    });

    api.on("after_compaction", (event, ctx) => {
      hooks.onAfterCompaction(event, ctx);
    });

    api.on("gateway_start", () => {
      void service.reconcile();
    });
  },
});
