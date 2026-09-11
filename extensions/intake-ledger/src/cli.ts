import type { Command } from "commander";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { IntakeDeliveryAdapter } from "./adapters.js";
import type { IntakeLedgerConfig } from "./config.js";
import { createProductionDeliveryAdapters } from "./delivery.js";
import { IntakeLedgerService } from "./service.js";
import type { IntakeLedgerStore } from "./store.js";

type JsonOptions = { json?: boolean };

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function fail(err: unknown): never {
  process.stderr.write(`${formatErrorMessage(err)}\n`);
  process.exitCode = 1;
  throw err instanceof Error ? err : new Error(formatErrorMessage(err));
}

export function registerIntakeLedgerCli(params: {
  program: Command;
  store: IntakeLedgerStore;
  config: IntakeLedgerConfig;
  adapters?: IntakeDeliveryAdapter[];
}): void {
  const service = new IntakeLedgerService(
    params.store,
    params.config,
    params.adapters ?? createProductionDeliveryAdapters({ config: params.config }),
  );
  const root = params.program
    .command("intake-ledger")
    .description("Inspect, reconcile, and audit the request-intake ledger");

  root
    .command("unresolved")
    .description(
      "List unresolved intake receipts, reviewable matches, and undelivered outbox items",
    )
    .option("--json", "Print JSON")
    .action((options: JsonOptions) => {
      try {
        const unresolved = service.audit().unresolved;
        if (options.json) {
          writeJson({ unresolved });
          return;
        }
        if (unresolved.length === 0) {
          writeLine("No unresolved intake entries.");
          return;
        }
        for (const entry of unresolved) {
          const when = entry.sourceTimestampMs
            ? new Date(entry.sourceTimestampMs).toISOString()
            : new Date(entry.receivedAtMs).toISOString();
          writeLine(`${entry.kind} ${entry.channel} ${entry.messageId} ${when} ${entry.reason}`);
        }
      } catch (err) {
        fail(err);
      }
    });

  root
    .command("audit")
    .description("Print unresolved entries, open alerts, and the latest backfill coverage boundary")
    .option("--json", "Print JSON")
    .action((options: JsonOptions) => {
      try {
        const report = service.audit();
        if (options.json) {
          writeJson(report);
          return;
        }
        writeLine(`Unresolved: ${report.unresolved.length}`);
        writeLine(`Open alerts: ${report.alerts.length}`);
        if (report.backfill) {
          writeLine(
            `Backfill ${report.backfill.id}: proven=${report.backfill.provenCount} likely=${report.backfill.likelyCount} unprovable=${report.backfill.unprovableCount}`,
          );
          writeLine(`Coverage: ${report.backfill.coverageBoundary}`);
        } else {
          writeLine("No backfill run recorded.");
        }
      } catch (err) {
        fail(err);
      }
    });

  root
    .command("reconcile")
    .description("Retry due outbox items and alert on unresolved receipts")
    .option("--json", "Print JSON")
    .action(async (options: JsonOptions) => {
      try {
        const result = await service.reconcile();
        if (options.json) {
          writeJson(result);
          return;
        }
        writeLine(
          `Reconciled: attempted=${result.attempted} delivered=${result.delivered} retried=${result.retried} failed=${result.failed} alerts=${result.alerts}`,
        );
      } catch (err) {
        fail(err);
      }
    });

  root
    .command("complete")
    .description("Complete a claimed outbox item after a confirmed remote side effect")
    .requiredOption("--idempotency-key <key>", "Outbox idempotency key")
    .option("--remote-id <id>", "Canonical remote task id")
    .option("--claim-token <token>", "Current claim token")
    .option("--json", "Print JSON")
    .action(
      (
        options: JsonOptions & { idempotencyKey: string; remoteId?: string; claimToken?: string },
      ) => {
        try {
          const item = service.ackDelivery(
            options.idempotencyKey,
            options.remoteId,
            options.claimToken,
          );
          if (!item) {
            throw new Error(`outbox item not found: ${options.idempotencyKey}`);
          }
          if (options.json) {
            writeJson({ id: item.id, status: item.status, kind: item.kind });
            return;
          }
          writeLine(`${item.kind} ${item.status} ${item.id}`);
        } catch (err) {
          fail(err);
        }
      },
    );

  root
    .command("canonical")
    .description("List created or linked canonical tasks visible to implementation workers")
    .option("--board <id>", "Intake board id")
    .option("--json", "Print JSON")
    .action((options: JsonOptions & { board?: string }) => {
      try {
        const tasks = service.canonicalReady(options.board);
        if (options.json) {
          writeJson({ tasks });
          return;
        }
        if (tasks.length === 0) {
          writeLine("No created or linked canonical tasks.");
          return;
        }
        for (const task of tasks) {
          writeLine(`${task.disposition} ${task.canonicalTaskId ?? "-"} ${task.requestText}`);
        }
      } catch (err) {
        fail(err);
      }
    });
}
