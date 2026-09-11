import { randomUUID } from "node:crypto";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { IntakeClaimAuthorityError } from "./disposition-policy.js";
import { buildOutboxIdempotencyKey } from "./idempotency.js";
import { boundAlertMessage, redactPersistedError } from "./privacy.js";
import { toAlert, toBackfill, toEnvelope, toOutbox } from "./store-codec.js";
import { MAX_OUTBOX_ATTEMPTS, nextOutboxBackoffMs } from "./store-schema.js";
import { INTAKE_IDEMPOTENT_OUTBOX_KINDS } from "./types.js";
import type {
  IntakeAlert,
  IntakeBackfillFinding,
  IntakeBackfillRun,
  IntakeDatabase,
  IntakeDeliveryResult,
  IntakeEnvelope,
  IntakeOutboxItem,
  IntakeReceipt,
  IntakeUnresolvedEntry,
} from "./types.js";

type Database = import("node:sqlite").DatabaseSync;

export abstract class IntakeLedgerRecoveryStore {
  protected abstract readonly db: Database;
  protected abstract readonly query: ReturnType<typeof getNodeSqliteKysely<IntakeDatabase>>;
  protected abstract readonly now: () => number;
  abstract getEnvelope(id: string): IntakeEnvelope | undefined;
  abstract listReceipts(envelopeId: string): IntakeReceipt[];

  listUnresolved(params?: { olderThanMs?: number; now?: number }): IntakeUnresolvedEntry[] {
    const now = params?.now ?? this.now();
    const olderThanMs = params?.olderThanMs ?? 0;
    const entries: IntakeUnresolvedEntry[] = [];
    const envelopes = executeSqliteQuerySync(
      this.db,
      this.query.selectFrom("intake_envelopes").selectAll().orderBy("received_at_ms", "asc"),
    ).rows.map(toEnvelope);
    for (const envelope of envelopes) {
      if (envelope.extractionStatus === "pending" && now - envelope.receivedAtMs >= olderThanMs) {
        entries.push({
          kind: "pending_extraction",
          envelopeId: envelope.id,
          boardId: envelope.boardId,
          channel: envelope.channel,
          messageId: envelope.messageId,
          sourceTimestampMs: envelope.sourceTimestampMs,
          receivedAtMs: envelope.receivedAtMs,
          reason: "inbound envelope has no recorded atomic receipts",
        });
      }
      for (const receipt of this.listReceipts(envelope.id)) {
        if (receipt.conflict && now - receipt.createdAtMs >= olderThanMs) {
          entries.push({
            kind: "replay_conflict",
            envelopeId: envelope.id,
            receiptId: receipt.id,
            boardId: envelope.boardId,
            channel: envelope.channel,
            messageId: envelope.messageId,
            sourceTimestampMs: envelope.sourceTimestampMs,
            receivedAtMs: envelope.receivedAtMs,
            requestText: receipt.requestText,
            reason: receipt.conflict,
          });
        }
        if (
          receipt.requestedDisposition &&
          !receipt.disposition &&
          now - receipt.createdAtMs >= olderThanMs
        ) {
          entries.push({
            kind: "pending_remote",
            envelopeId: envelope.id,
            receiptId: receipt.id,
            boardId: envelope.boardId,
            channel: envelope.channel,
            messageId: envelope.messageId,
            sourceTimestampMs: envelope.sourceTimestampMs,
            receivedAtMs: envelope.receivedAtMs,
            requestText: receipt.requestText,
            reason: `requested ${receipt.requestedDisposition} awaits confirmed canonical result`,
            disposition: receipt.requestedDisposition,
          });
        }
        if (
          !receipt.disposition &&
          !receipt.requestedDisposition &&
          now - receipt.createdAtMs >= olderThanMs
        ) {
          entries.push({
            kind: "undisposed_receipt",
            envelopeId: envelope.id,
            receiptId: receipt.id,
            boardId: envelope.boardId,
            channel: envelope.channel,
            messageId: envelope.messageId,
            sourceTimestampMs: envelope.sourceTimestampMs,
            receivedAtMs: envelope.receivedAtMs,
            requestText: receipt.requestText,
            reason: "atomic request has no terminal disposition",
          });
        }
        if (
          (receipt.disposition === "needs_canonical_review" ||
            receipt.disposition === "needs_clarification") &&
          now - receipt.createdAtMs >= olderThanMs
        ) {
          entries.push({
            kind: "reviewable",
            envelopeId: envelope.id,
            receiptId: receipt.id,
            boardId: envelope.boardId,
            channel: envelope.channel,
            messageId: envelope.messageId,
            sourceTimestampMs: envelope.sourceTimestampMs,
            receivedAtMs: envelope.receivedAtMs,
            requestText: receipt.requestText,
            disposition: receipt.disposition,
            reason:
              receipt.dispositionReason ??
              (receipt.disposition === "needs_canonical_review"
                ? "ambiguous canonical match remains reviewable"
                : "awaiting clarification"),
          });
        }
      }
    }
    const undelivered = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_outbox")
        .selectAll()
        .where("status", "in", ["pending", "in_flight", "failed"])
        .orderBy("created_at_ms", "asc"),
    ).rows.map(toOutbox);
    for (const item of undelivered) {
      if (now - item.createdAtMs < olderThanMs) {
        continue;
      }
      const envelope = item.envelopeId ? this.getEnvelope(item.envelopeId) : undefined;
      if (!envelope) {
        continue;
      }
      entries.push({
        kind: "undelivered_outbox",
        envelopeId: envelope.id,
        receiptId: item.receiptId,
        outboxId: item.id,
        boardId: envelope.boardId,
        channel: envelope.channel,
        messageId: envelope.messageId,
        sourceTimestampMs: envelope.sourceTimestampMs,
        receivedAtMs: envelope.receivedAtMs,
        reason: item.lastError ?? `outbox ${item.kind} is ${item.status}`,
      });
    }
    return entries;
  }

  listDueOutbox(now = this.now()): IntakeOutboxItem[] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_outbox")
        .selectAll()
        .where("status", "=", "pending")
        .where("next_attempt_at_ms", "<=", now)
        .orderBy("next_attempt_at_ms", "asc"),
    ).rows.map(toOutbox);
  }

  recoverStuckInFlight(params: { now?: number; timeoutMs: number }): number {
    const now = params.now ?? this.now();
    const cutoff = now - params.timeoutMs;
    const stuck = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_outbox")
        .selectAll()
        .where("status", "=", "in_flight")
        .where("updated_at_ms", "<=", cutoff),
    ).rows.map(toOutbox);
    let recovered = 0;
    for (const item of stuck) {
      const idempotent = (INTAKE_IDEMPOTENT_OUTBOX_KINDS as readonly string[]).includes(item.kind);
      if (idempotent) {
        const update = compileSqliteQueryBindings<{ id: string; now: number; error: string }>((p) =>
          this.query
            .updateTable("intake_outbox")
            .set({
              status: "pending",
              next_attempt_at_ms: p((row) => row.now),
              updated_at_ms: p((row) => row.now),
              last_error: p((row) => row.error),
              claim_token: null,
            })
            .where(
              "id",
              "=",
              p((row) => row.id),
            )
            .where("status", "=", "in_flight"),
        );
        const result = this.db.prepare(update.compiled.sql).run(
          ...update.bind({
            id: item.id,
            now,
            error: redactPersistedError("in-flight delivery interrupted; retry is idempotent"),
          }),
        );
        recovered += Number(result.changes ?? 0);
        continue;
      }
      this.recordDeliveryResult(
        item.id,
        {
          ok: false,
          error: "ambiguous in-flight send; review before retry",
          retryable: false,
        },
        item.claimToken,
      );
      recovered += 1;
    }
    return recovered;
  }

  claimOutbox(id: string): IntakeOutboxItem | undefined {
    const current = this.getOutbox(id);
    if (!current || current.status !== "pending") {
      return undefined;
    }
    const now = this.now();
    const claimToken = randomUUID();
    const update = compileSqliteQueryBindings<{
      id: string;
      now: number;
      attemptCount: number;
      claimToken: string;
    }>((p) =>
      this.query
        .updateTable("intake_outbox")
        .set({
          status: "in_flight",
          attempt_count: p((row) => row.attemptCount),
          updated_at_ms: p((row) => row.now),
          claim_token: p((row) => row.claimToken),
        })
        .where(
          "id",
          "=",
          p((row) => row.id),
        )
        .where("status", "=", "pending"),
    );
    const result = this.db.prepare(update.compiled.sql).run(
      ...update.bind({
        id,
        now,
        attemptCount: current.attemptCount + 1,
        claimToken,
      }),
    );
    if (Number(result.changes ?? 0) !== 1) {
      return undefined;
    }
    return this.getOutbox(id);
  }

  recordDeliveryResult(
    id: string,
    result: IntakeDeliveryResult,
    claimToken?: string,
  ): IntakeOutboxItem {
    const current = this.requireOutbox(id);
    if (current.status === "delivered") {
      return current;
    }
    if (
      current.status === "in_flight" &&
      claimToken &&
      current.claimToken &&
      claimToken !== current.claimToken
    ) {
      return current;
    }
    if (current.status === "failed" && !result.ok) {
      return current;
    }
    if (current.status === "in_flight" && !claimToken) {
      return current;
    }
    const now = this.now();
    if (!result.ok && "awaitingExternal" in result) {
      const update = compileSqliteQueryBindings<{ id: string; now: number; error: string }>((p) =>
        this.query
          .updateTable("intake_outbox")
          .set({
            last_error: p((row) => row.error),
            updated_at_ms: p((row) => row.now),
          })
          .where(
            "id",
            "=",
            p((row) => row.id),
          )
          .where("status", "=", "in_flight"),
      );
      this.db.prepare(update.compiled.sql).run(
        ...update.bind({
          id,
          now,
          error: redactPersistedError(result.error ?? "awaiting automation job completion"),
        }),
      );
      return this.requireOutbox(id);
    }
    if (result.ok) {
      const update = compileSqliteQueryBindings<{
        id: string;
        now: number;
        payloadJson: string;
      }>((p) =>
        this.query
          .updateTable("intake_outbox")
          .set({
            status: "delivered",
            last_error: null,
            delivered_at_ms: p((row) => row.now),
            updated_at_ms: p((row) => row.now),
            payload_json: p((row) => row.payloadJson),
          })
          .where(
            "id",
            "=",
            p((row) => row.id),
          )
          .where("status", "in", ["pending", "in_flight"]),
      );
      const payload = {
        ...current.payload,
        ...(result.remoteId ? { remoteId: result.remoteId } : {}),
      };
      this.db
        .prepare(update.compiled.sql)
        .run(...update.bind({ id, now, payloadJson: JSON.stringify(payload) }));
      return this.requireOutbox(id);
    }
    const failure = result;
    const attemptsExhausted = !failure.retryable || current.attemptCount >= MAX_OUTBOX_ATTEMPTS;
    if (attemptsExhausted) {
      const update = compileSqliteQueryBindings<{ id: string; now: number; error: string }>((p) =>
        this.query
          .updateTable("intake_outbox")
          .set({
            status: "failed",
            last_error: p((row) => row.error),
            updated_at_ms: p((row) => row.now),
          })
          .where(
            "id",
            "=",
            p((row) => row.id),
          )
          .where("status", "in", ["pending", "in_flight"]),
      );
      this.db
        .prepare(update.compiled.sql)
        .run(...update.bind({ id, now, error: redactPersistedError(failure.error) }));
      this.insertAlert({
        envelopeId: current.envelopeId,
        receiptId: current.receiptId,
        kind: `outbox_${current.kind}_failed`,
        message: failure.error,
      });
      return this.requireOutbox(id);
    }
    const update = compileSqliteQueryBindings<{
      id: string;
      now: number;
      nextAttemptAtMs: number;
      error: string;
    }>((p) =>
      this.query
        .updateTable("intake_outbox")
        .set({
          status: "pending",
          last_error: p((row) => row.error),
          next_attempt_at_ms: p((row) => row.nextAttemptAtMs),
          updated_at_ms: p((row) => row.now),
          claim_token: null,
        })
        .where(
          "id",
          "=",
          p((row) => row.id),
        )
        .where("status", "in", ["pending", "in_flight"]),
    );
    this.db.prepare(update.compiled.sql).run(
      ...update.bind({
        id,
        now,
        nextAttemptAtMs: now + nextOutboxBackoffMs(current.attemptCount),
        error: redactPersistedError(failure.error),
      }),
    );
    return this.requireOutbox(id);
  }

  ackDelivery(
    idempotencyKey: string,
    remoteId?: string,
    claimToken?: string,
    canonicalTaskUrl?: string,
  ): IntakeOutboxItem | undefined {
    const item = this.getOutboxByIdempotencyKey(idempotencyKey);
    if (!item) {
      return undefined;
    }
    const token = typeof claimToken === "string" ? claimToken : "";
    if (!token) {
      throw new IntakeClaimAuthorityError(
        `claim token is required to complete ${item.idempotencyKey}`,
      );
    }
    if (item.status !== "in_flight") {
      throw new IntakeClaimAuthorityError(
        `outbox item ${item.idempotencyKey} is ${item.status}, not in_flight`,
      );
    }
    if (!item.claimToken || token !== item.claimToken) {
      throw new IntakeClaimAuthorityError(
        `claim token does not match the current in-flight token for ${item.idempotencyKey}`,
      );
    }
    const remoteIdentity = (remoteId?.trim() || canonicalTaskUrl?.trim()) ?? "";
    if (
      (item.kind === "notion_create" ||
        item.kind === "notion_link" ||
        item.kind === "notion_update") &&
      !remoteIdentity
    ) {
      throw new IntakeClaimAuthorityError(
        `canonical task id or url is required to complete ${item.kind} ${item.idempotencyKey}`,
      );
    }
    return this.recordDeliveryResult(item.id, { ok: true, remoteId }, token);
  }

  insertAlert(params: {
    envelopeId?: string;
    receiptId?: string;
    kind: string;
    message: string;
  }): IntakeAlert {
    const message = boundAlertMessage(params.message);
    const openAlerts = this.listOpenAlerts();
    const existing = openAlerts.find(
      (alert) =>
        alert.kind === params.kind &&
        alert.envelopeId === params.envelopeId &&
        alert.receiptId === params.receiptId,
    );
    if (existing) {
      return existing;
    }
    const id = randomUUID();
    const createdAtMs = this.now();
    const insert = compileSqliteQueryBindings<typeof params & { id: string; createdAtMs: number }>(
      (p) =>
        this.query.insertInto("intake_alerts").values({
          id: p((row) => row.id),
          envelope_id: p((row) => row.envelopeId ?? null),
          receipt_id: p((row) => row.receiptId ?? null),
          kind: p((row) => row.kind),
          message: p((row) => row.message),
          created_at_ms: p((row) => row.createdAtMs),
          acknowledged_at_ms: null,
        }),
    );
    this.db
      .prepare(insert.compiled.sql)
      .run(...insert.bind({ ...params, message, id, createdAtMs }));
    const alert = this.requireAlert(id);
    if (!params.kind.startsWith("outbox_alert")) {
      this.enqueueAlertOutbox(alert);
    }
    return alert;
  }

  listOpenAlerts(): IntakeAlert[] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_alerts")
        .selectAll()
        .where("acknowledged_at_ms", "is", null)
        .orderBy("created_at_ms", "asc"),
    ).rows.map(toAlert);
  }

  recordBackfill(params: {
    boardId: string;
    coverageBoundary: string;
    findings: IntakeBackfillFinding[];
  }): IntakeBackfillRun {
    const id = randomUUID();
    const startedAtMs = this.now();
    const provenCount = params.findings.filter((finding) => finding.confidence === "proven").length;
    const likelyCount = params.findings.filter((finding) => finding.confidence === "likely").length;
    const unprovableCount = params.findings.filter(
      (finding) => finding.confidence === "unprovable",
    ).length;
    const insert = compileSqliteQueryBindings<
      typeof params & {
        id: string;
        startedAtMs: number;
        provenCount: number;
        likelyCount: number;
        unprovableCount: number;
      }
    >((p) =>
      this.query.insertInto("intake_backfill_runs").values({
        id: p((row) => row.id),
        board_id: p((row) => row.boardId),
        started_at_ms: p((row) => row.startedAtMs),
        completed_at_ms: p((row) => row.startedAtMs),
        coverage_boundary: p((row) => row.coverageBoundary),
        proven_count: p((row) => row.provenCount),
        likely_count: p((row) => row.likelyCount),
        unprovable_count: p((row) => row.unprovableCount),
        result_json: p((row) => JSON.stringify(row.findings)),
      }),
    );
    this.db
      .prepare(insert.compiled.sql)
      .run(
        ...insert.bind({ ...params, id, startedAtMs, provenCount, likelyCount, unprovableCount }),
      );
    return this.requireBackfill(id);
  }

  latestBackfill(boardId?: string): IntakeBackfillRun | undefined {
    let query = this.query.selectFrom("intake_backfill_runs").selectAll();
    if (boardId) {
      query = query.where("board_id", "=", boardId);
    }
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      query.orderBy("started_at_ms", "desc").limit(1),
    );
    return row ? toBackfill(row) : undefined;
  }

  getOutbox(id: string): IntakeOutboxItem | undefined {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("intake_outbox").selectAll().where("id", "=", id),
    );
    return row ? toOutbox(row) : undefined;
  }

  getOutboxByIdempotencyKey(idempotencyKey: string): IntakeOutboxItem | undefined {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("intake_outbox")
        .selectAll()
        .where("idempotency_key", "=", idempotencyKey),
    );
    return row ? toOutbox(row) : undefined;
  }

  listOutboxForReceipt(receiptId: string): IntakeOutboxItem[] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_outbox")
        .selectAll()
        .where("receipt_id", "=", receiptId)
        .orderBy("created_at_ms", "asc"),
    ).rows.map(toOutbox);
  }

  listOutboxForEnvelope(envelopeId: string): IntakeOutboxItem[] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_outbox")
        .selectAll()
        .where("envelope_id", "=", envelopeId)
        .orderBy("created_at_ms", "asc"),
    ).rows.map(toOutbox);
  }

  private requireOutbox(id: string): IntakeOutboxItem {
    const item = this.getOutbox(id);
    if (!item) {
      throw new Error(`intake outbox item not found: ${id}`);
    }
    return item;
  }

  private requireAlert(id: string): IntakeAlert {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("intake_alerts").selectAll().where("id", "=", id),
    );
    if (!row) {
      throw new Error(`intake alert not found: ${id}`);
    }
    return toAlert(row);
  }

  private enqueueAlertOutbox(alert: IntakeAlert): void {
    const envelope = alert.envelopeId ? this.getEnvelope(alert.envelopeId) : undefined;
    const now = this.now();
    const insert = compileSqliteQueryBindings<{
      id: string;
      receiptId: string | null;
      envelopeId: string | null;
      nextAttemptAtMs: number;
      payloadJson: string;
      idempotencyKey: string;
      createdAtMs: number;
    }>((p) =>
      this.query
        .insertInto("intake_outbox")
        .values({
          id: p((row) => row.id),
          receipt_id: p((row) => row.receiptId),
          envelope_id: p((row) => row.envelopeId),
          kind: "alert",
          status: "pending",
          attempt_count: 0,
          next_attempt_at_ms: p((row) => row.nextAttemptAtMs),
          last_error: null,
          payload_json: p((row) => row.payloadJson),
          idempotency_key: p((row) => row.idempotencyKey),
          claim_token: null,
          created_at_ms: p((row) => row.createdAtMs),
          updated_at_ms: p((row) => row.createdAtMs),
          delivered_at_ms: null,
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing()),
    );
    this.db.prepare(insert.compiled.sql).run(
      ...insert.bind({
        id: randomUUID(),
        receiptId: alert.receiptId ?? null,
        envelopeId: alert.envelopeId ?? null,
        nextAttemptAtMs: now,
        payloadJson: JSON.stringify({
          kind: alert.kind,
          message: alert.message,
          channel: envelope?.channel ?? null,
          accountId: envelope?.accountId ?? null,
          peerId: envelope?.peerId ?? null,
          sessionKey: envelope?.sessionKey ?? null,
          messageId: envelope?.messageId ?? null,
        }),
        idempotencyKey: buildOutboxIdempotencyKey({
          kind: "alert",
          alertId: alert.id,
          receiptId: alert.receiptId,
          envelopeId: alert.envelopeId,
        }),
        createdAtMs: now,
      }),
    );
  }

  private requireBackfill(id: string): IntakeBackfillRun {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("intake_backfill_runs").selectAll().where("id", "=", id),
    );
    if (!row) {
      throw new Error(`intake backfill run not found: ${id}`);
    }
    return toBackfill(row);
  }
}
