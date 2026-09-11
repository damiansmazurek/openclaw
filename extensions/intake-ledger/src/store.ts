import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  isConfirmedRemoteResult,
  isRequestedRemoteWork,
  IntakeReplayConflictError,
  receiptDispositionFingerprint,
  dispositionFingerprint,
  validateDispositionFields,
  validateRequestIndices,
} from "./disposition-policy.js";
import { buildIntakeIdempotencyKey, buildOutboxIdempotencyKey } from "./idempotency.js";
import { isTerminalDisposition, toEnvelope, toReceipt } from "./store-codec.js";
import {
  INTAKE_LEDGER_SCHEMA,
  INTAKE_SCHEMA_VERSION,
  INTAKE_SQLITE_BUSY_TIMEOUT_MS,
  INTAKE_SQLITE_DIR_MODE,
  INTAKE_SQLITE_FILE_MODE,
  resolveIntakeLedgerDir,
} from "./store-schema.js";
import { IntakeLedgerWriteStore } from "./store-write.js";
import type {
  IntakeAtomicRequest,
  IntakeCanonicalReadyDisposition,
  IntakeDatabase,
  IntakeDispositionInput,
  IntakeEnvelope,
  IntakeOutboxItem,
  IntakeReceipt,
  IntakeSourceRef,
} from "./types.js";
import { INTAKE_CANONICAL_READY_DISPOSITIONS } from "./types.js";

type Database = import("node:sqlite").DatabaseSync;

export class IntakeCompletenessError extends Error {
  readonly envelopeId: string;
  readonly extractedCount: number;
  readonly disposedCount: number;

  constructor(params: { envelopeId: string; extractedCount: number; disposedCount: number }) {
    super(
      `intake completeness failed for ${params.envelopeId}: extracted ${params.extractedCount}, disposed ${params.disposedCount}`,
    );
    this.name = "IntakeCompletenessError";
    this.envelopeId = params.envelopeId;
    this.extractedCount = params.extractedCount;
    this.disposedCount = params.disposedCount;
  }
}

export class IntakeLedgerStore extends IntakeLedgerWriteStore {
  protected readonly db: Database;
  protected readonly query;
  private readonly walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas>;

  constructor(
    readonly dataDir: string,
    protected readonly now: () => number = () => Date.now(),
  ) {
    super();
    mkdirSync(dataDir, { recursive: true, mode: INTAKE_SQLITE_DIR_MODE });
    chmodSync(dataDir, INTAKE_SQLITE_DIR_MODE);
    const dbPath = path.join(dataDir, "intake-ledger.sqlite");
    const db = openNodeSqliteDatabase(dbPath);
    let walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
    try {
      chmodSync(dbPath, INTAKE_SQLITE_FILE_MODE);
      walMaintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: INTAKE_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "intake-ledger",
        databasePath: dbPath,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      const versionRow = db.prepare("PRAGMA user_version").get() as
        | { user_version?: unknown }
        | undefined;
      const schemaVersion = Number(versionRow?.user_version ?? 0);
      if (schemaVersion > INTAKE_SCHEMA_VERSION) {
        throw new Error(
          `Intake ledger database uses newer schema version ${schemaVersion}; this build supports ${INTAKE_SCHEMA_VERSION}`,
        );
      }
      db.exec(INTAKE_LEDGER_SCHEMA);
      if (schemaVersion < INTAKE_SCHEMA_VERSION) {
        migrateSqliteSchemaToStrict(db, INTAKE_LEDGER_SCHEMA, { databaseLabel: dbPath });
        db.exec(`PRAGMA user_version = ${INTAKE_SCHEMA_VERSION};`);
      }
    } catch (error) {
      walMaintenance?.close();
      db.close();
      throw error;
    }
    if (!walMaintenance) {
      db.close();
      throw new Error("Intake ledger SQLite maintenance failed to initialize");
    }
    this.db = db;
    this.walMaintenance = walMaintenance;
    this.query = getNodeSqliteKysely<IntakeDatabase>(db);
  }

  static open(env: NodeJS.ProcessEnv = process.env, now?: () => number): IntakeLedgerStore {
    return new IntakeLedgerStore(resolveIntakeLedgerDir(env), now);
  }

  close(): void {
    this.walMaintenance.close();
    this.db.close();
  }

  persistEnvelope(source: IntakeSourceRef): IntakeEnvelope {
    const existing = this.getEnvelopeBySource(source.boardId, source.channel, source.messageId);
    if (existing) {
      return existing;
    }
    const id = randomUUID();
    const receivedAtMs = this.now();
    const insert = compileSqliteQueryBindings<
      IntakeSourceRef & { id: string; receivedAtMs: number }
    >((p) =>
      this.query
        .insertInto("intake_envelopes")
        .values({
          id: p((row) => row.id),
          board_id: p((row) => row.boardId),
          channel: p((row) => row.channel),
          account_id: p((row) => row.accountId ?? null),
          peer_id: p((row) => row.peerId ?? null),
          message_id: p((row) => row.messageId),
          sender_id: p((row) => row.senderId ?? null),
          source_timestamp_ms: p((row) => row.sourceTimestampMs ?? null),
          received_at_ms: p((row) => row.receivedAtMs),
          session_key: p((row) => row.sessionKey ?? null),
          run_id: p((row) => row.runId ?? null),
          extraction_status: "pending",
          extracted_count: 0,
        })
        .onConflict((oc) => oc.columns(["board_id", "channel", "message_id"]).doNothing()),
    );
    this.db.prepare(insert.compiled.sql).run(...insert.bind({ ...source, id, receivedAtMs }));
    const stored = this.getEnvelopeBySource(source.boardId, source.channel, source.messageId);
    if (!stored) {
      throw new Error("intake envelope persist failed");
    }
    return stored;
  }

  recordRequests(params: {
    envelopeId: string;
    requests: IntakeAtomicRequest[];
    turnId?: string;
  }): { envelope: IntakeEnvelope; receipts: IntakeReceipt[]; created: number } {
    this.requireEnvelope(params.envelopeId);
    validateRequestIndices(params.requests);
    const createdAtMs = this.now();
    const insertReceipt = compileSqliteQueryBindings<{
      id: string;
      envelopeId: string;
      idempotencyKey: string;
      requestIndex: number;
      requestText: string;
      createdAtMs: number;
      turnId: string | null;
    }>((p) =>
      this.query
        .insertInto("intake_receipts")
        .values({
          id: p((row) => row.id),
          envelope_id: p((row) => row.envelopeId),
          idempotency_key: p((row) => row.idempotencyKey),
          request_index: p((row) => row.requestIndex),
          request_text: p((row) => row.requestText),
          created_at_ms: p((row) => row.createdAtMs),
          requested_disposition: null,
          disposition: null,
          disposition_reason: null,
          canonical_task_id: null,
          canonical_task_url: null,
          review_owner: null,
          review_deadline_ms: null,
          turn_id: p((row) => row.turnId),
          conflict: null,
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing()),
    );
    const insertStmt = this.db.prepare(insertReceipt.compiled.sql);
    const created = runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const current = this.requireEnvelope(params.envelopeId);
        let inserted = 0;
        for (const request of params.requests) {
          const idempotencyKey = buildIntakeIdempotencyKey({
            channel: current.channel,
            messageId: current.messageId,
            requestIndex: request.requestIndex,
          });
          const existing = this.getReceiptByIdempotencyKey(idempotencyKey);
          if (existing && existing.requestText !== request.requestText) {
            this.persistReplayConflict({
              receiptId: existing.id,
              envelopeId: existing.envelopeId,
              idempotencyKey,
              stored: existing.requestText,
              received: request.requestText,
            });
            throw new IntakeReplayConflictError({
              idempotencyKey,
              stored: existing.requestText,
              received: request.requestText,
            });
          }
          if (existing) {
            continue;
          }
          const result = insertStmt.run(
            ...insertReceipt.bind({
              id: randomUUID(),
              envelopeId: current.id,
              idempotencyKey,
              requestIndex: request.requestIndex,
              requestText: request.requestText,
              createdAtMs,
              turnId: params.turnId ?? null,
            }),
          );
          inserted += Number(result.changes ?? 0);
        }
        const countRow = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query
            .selectFrom("intake_receipts")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("envelope_id", "=", current.id),
        );
        const extractedCount = countRow?.count ?? 0;
        const update = compileSqliteQueryBindings<{ id: string; extractedCount: number }>((p) =>
          this.query
            .updateTable("intake_envelopes")
            .set({
              extraction_status: "extracted",
              extracted_count: p((row) => row.extractedCount),
            })
            .where(
              "id",
              "=",
              p((row) => row.id),
            ),
        );
        this.db
          .prepare(update.compiled.sql)
          .run(...update.bind({ id: current.id, extractedCount }));
        return inserted;
      },
      {
        busyTimeoutMs: INTAKE_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "intake-ledger",
        operationLabel: "intake.receipts.record",
      },
    );
    return {
      envelope: this.requireEnvelope(params.envelopeId),
      receipts: this.listReceipts(params.envelopeId),
      created,
    };
  }

  recordDisposition(input: IntakeDispositionInput): {
    receipt: IntakeReceipt;
    outbox: IntakeOutboxItem[];
    replayed: boolean;
    pendingRemote: boolean;
  } {
    if (!isTerminalDisposition(input.disposition)) {
      throw new Error(`invalid intake disposition: ${String(input.disposition)}`);
    }
    validateDispositionFields(input);
    const receipt = this.resolveReceipt(input);
    const incoming = dispositionFingerprint(input);
    if (receipt.disposition) {
      const stored = receiptDispositionFingerprint(receipt);
      if (stored === incoming) {
        return {
          receipt,
          outbox: this.listOutboxForReceipt(receipt.id),
          replayed: true,
          pendingRemote: false,
        };
      }
      this.persistReplayConflict({
        receiptId: receipt.id,
        envelopeId: receipt.envelopeId,
        idempotencyKey: receipt.idempotencyKey,
        stored,
        received: incoming,
      });
      throw new IntakeReplayConflictError({
        idempotencyKey: receipt.idempotencyKey,
        stored,
        received: incoming,
      });
    }
    if (receipt.requestedDisposition) {
      const stored = receiptDispositionFingerprint({
        ...receipt,
        disposition: receipt.requestedDisposition,
      });
      const confirmingSameRemote =
        isConfirmedRemoteResult(input) && receipt.requestedDisposition === input.disposition;
      if (stored !== incoming && !confirmingSameRemote) {
        this.persistReplayConflict({
          receiptId: receipt.id,
          envelopeId: receipt.envelopeId,
          idempotencyKey: receipt.idempotencyKey,
          stored,
          received: incoming,
        });
        throw new IntakeReplayConflictError({
          idempotencyKey: receipt.idempotencyKey,
          stored,
          received: incoming,
        });
      }
      if (!confirmingSameRemote && isRequestedRemoteWork(input)) {
        return {
          receipt,
          outbox: this.listOutboxForReceipt(receipt.id),
          replayed: true,
          pendingRemote: true,
        };
      }
    }
    const now = this.now();
    const pendingRemote = isRequestedRemoteWork(input);
    const confirmRemote = isConfirmedRemoteResult(input);
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const current = this.requireReceiptById(receipt.id);
        if (current.disposition) {
          return;
        }
        this.applyDispositionRow({
          id: receipt.id,
          input,
          pendingRemote,
        });
        if (confirmRemote) {
          this.settleExistingRemoteOutbox(receipt.id, now);
          return;
        }
        if (!pendingRemote) {
          return;
        }
        this.enqueueRemoteOutbox({
          receipt: current,
          input,
          now,
        });
      },
      {
        busyTimeoutMs: INTAKE_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "intake-ledger",
        operationLabel: "intake.disposition.record",
      },
    );
    const stored = this.requireReceiptById(receipt.id);
    return {
      receipt: stored,
      outbox: this.listOutboxForReceipt(receipt.id),
      replayed: false,
      pendingRemote: Boolean(stored.requestedDisposition && !stored.disposition),
    };
  }

  assertCompleteness(envelopeId: string): { envelope: IntakeEnvelope; receipts: IntakeReceipt[] } {
    const envelope = this.requireEnvelope(envelopeId);
    const receipts = this.listReceipts(envelopeId);
    const disposedCount = receipts.filter((receipt) => receipt.disposition).length;
    if (envelope.extractionStatus !== "extracted" || envelope.extractedCount !== disposedCount) {
      throw new IntakeCompletenessError({
        envelopeId,
        extractedCount: envelope.extractedCount,
        disposedCount,
      });
    }
    if (receipts.length !== envelope.extractedCount) {
      throw new IntakeCompletenessError({
        envelopeId,
        extractedCount: envelope.extractedCount,
        disposedCount: receipts.length,
      });
    }
    return { envelope, receipts };
  }

  closeTurn(envelopeId: string): {
    envelope: IntakeEnvelope;
    receipts: IntakeReceipt[];
    acknowledgement: IntakeOutboxItem;
  } {
    const { envelope, receipts } = this.assertCompleteness(envelopeId);
    const now = this.now();
    const idempotencyKey = buildOutboxIdempotencyKey({
      kind: "reply_ack",
      envelopeId: envelope.id,
    });
    const insert = compileSqliteQueryBindings<{
      id: string;
      envelopeId: string;
      nextAttemptAtMs: number;
      payloadJson: string;
      idempotencyKey: string;
      createdAtMs: number;
    }>((p) =>
      this.query
        .insertInto("intake_outbox")
        .values({
          id: p((row) => row.id),
          receipt_id: null,
          envelope_id: p((row) => row.envelopeId),
          kind: "reply_ack",
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
        envelopeId: envelope.id,
        nextAttemptAtMs: now,
        payloadJson: JSON.stringify({
          extractedCount: envelope.extractedCount,
          text: this.formatCloseAcknowledgement(envelope, receipts),
          channel: envelope.channel,
          accountId: envelope.accountId ?? null,
          peerId: envelope.peerId ?? null,
          sessionKey: envelope.sessionKey ?? null,
          messageId: envelope.messageId,
          intakeIdempotencyKey: buildOutboxIdempotencyKey({
            kind: "reply_ack",
            envelopeId: envelope.id,
          }),
          dispositions: receipts.map((receipt) => ({
            requestIndex: receipt.requestIndex,
            requestText: receipt.requestText,
            disposition: receipt.disposition,
            reason: receipt.dispositionReason ?? null,
            canonicalTaskId: receipt.canonicalTaskId ?? null,
            canonicalTaskUrl: receipt.canonicalTaskUrl ?? null,
          })),
        }),
        idempotencyKey,
        createdAtMs: now,
      }),
    );
    const acknowledgement = this.getOutboxByIdempotencyKey(idempotencyKey);
    if (!acknowledgement) {
      throw new Error(`intake acknowledgement outbox missing for ${envelope.id}`);
    }
    return { envelope, receipts, acknowledgement };
  }

  getEnvelope(id: string): IntakeEnvelope | undefined {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("intake_envelopes").selectAll().where("id", "=", id),
    );
    return row ? toEnvelope(row) : undefined;
  }

  getEnvelopeBySource(
    boardId: string,
    channel: string,
    messageId: string,
  ): IntakeEnvelope | undefined {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("intake_envelopes")
        .selectAll()
        .where("board_id", "=", boardId)
        .where("channel", "=", channel)
        .where("message_id", "=", messageId),
    );
    return row ? toEnvelope(row) : undefined;
  }

  listEnvelopesForSession(sessionKey: string | undefined): IntakeEnvelope[] {
    if (!sessionKey) {
      return [];
    }
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_envelopes")
        .selectAll()
        .where("session_key", "=", sessionKey)
        .orderBy("received_at_ms", "asc"),
    ).rows.map(toEnvelope);
  }

  listPendingExtractionEnvelopes(sessionKey: string | undefined): IntakeEnvelope[] {
    return this.listEnvelopesForSession(sessionKey).filter(
      (envelope) => envelope.extractionStatus === "pending",
    );
  }

  getPendingEnvelopeForSession(sessionKey: string | undefined): IntakeEnvelope | undefined {
    return this.listPendingExtractionEnvelopes(sessionKey)[0];
  }

  getLatestEnvelopeForSession(sessionKey: string | undefined): IntakeEnvelope | undefined {
    const envelopes = this.listEnvelopesForSession(sessionKey);
    return envelopes[envelopes.length - 1];
  }

  listReceipts(envelopeId: string): IntakeReceipt[] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_receipts")
        .selectAll()
        .where("envelope_id", "=", envelopeId)
        .orderBy("request_index", "asc"),
    ).rows.map(toReceipt);
  }

  getReceiptByIdempotencyKey(idempotencyKey: string): IntakeReceipt | undefined {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("intake_receipts")
        .selectAll()
        .where("idempotency_key", "=", idempotencyKey),
    );
    return row ? toReceipt(row) : undefined;
  }

  listReceiptsForBoard(boardId: string): IntakeReceipt[] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("intake_receipts")
        .innerJoin("intake_envelopes", "intake_envelopes.id", "intake_receipts.envelope_id")
        .selectAll("intake_receipts")
        .where("intake_envelopes.board_id", "=", boardId)
        .orderBy("intake_receipts.created_at_ms", "asc"),
    ).rows.map(toReceipt);
  }

  listCanonicalReady(boardId?: string): IntakeReceipt[] {
    let query = this.query
      .selectFrom("intake_receipts")
      .innerJoin("intake_envelopes", "intake_envelopes.id", "intake_receipts.envelope_id")
      .selectAll("intake_receipts")
      .where("intake_receipts.disposition", "in", [...INTAKE_CANONICAL_READY_DISPOSITIONS]);
    if (boardId) {
      query = query.where("intake_envelopes.board_id", "=", boardId);
    }
    return executeSqliteQuerySync(
      this.db,
      query.orderBy("intake_receipts.created_at_ms", "asc"),
    ).rows.map(toReceipt);
  }

  protected requireEnvelope(id: string): IntakeEnvelope {
    const envelope = this.getEnvelope(id);
    if (!envelope) {
      throw new Error(`intake envelope not found: ${id}`);
    }
    return envelope;
  }

  protected requireReceiptById(id: string): IntakeReceipt {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("intake_receipts").selectAll().where("id", "=", id),
    );
    if (!row) {
      throw new Error(`intake receipt not found: ${id}`);
    }
    return toReceipt(row);
  }

  private resolveReceipt(input: IntakeDispositionInput): IntakeReceipt {
    if (input.idempotencyKey) {
      const receipt = this.getReceiptByIdempotencyKey(input.idempotencyKey);
      if (!receipt) {
        throw new Error(`intake receipt not found: ${input.idempotencyKey}`);
      }
      return receipt;
    }
    if (input.envelopeId !== undefined && input.requestIndex !== undefined) {
      const row = executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("intake_receipts")
          .selectAll()
          .where("envelope_id", "=", input.envelopeId)
          .where("request_index", "=", input.requestIndex),
      );
      if (!row) {
        throw new Error(
          `intake receipt not found: envelope ${input.envelopeId} index ${input.requestIndex}`,
        );
      }
      return toReceipt(row);
    }
    throw new Error("intake disposition requires idempotencyKey or envelopeId+requestIndex");
  }
}

export { IntakeReplayConflictError } from "./disposition-policy.js";
export { nextOutboxBackoffMs, resolveIntakeLedgerDir } from "./store-schema.js";
export type { IntakeCanonicalReadyDisposition };
