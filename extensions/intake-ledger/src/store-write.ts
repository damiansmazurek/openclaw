import { randomUUID } from "node:crypto";
import { compileSqliteQueryBindings } from "openclaw/plugin-sdk/sqlite-runtime";
import { buildAcknowledgement } from "./ack.js";
import { buildOutboxIdempotencyKey } from "./idempotency.js";
import { boundAlertMessage } from "./privacy.js";
import { isRemoteDisposition } from "./disposition-policy.js";
import { outboxKindForDisposition } from "./store-codec.js";
import { IntakeLedgerRecoveryStore } from "./store-recovery.js";
import type {
  IntakeDispositionInput,
  IntakeEnvelope,
  IntakeOutboxKind,
  IntakeReceipt,
} from "./types.js";

export abstract class IntakeLedgerWriteStore extends IntakeLedgerRecoveryStore {
  protected abstract requireEnvelope(id: string): IntakeEnvelope;
  protected abstract requireReceiptById(id: string): IntakeReceipt;

  confirmReceiptFromRemote(params: {
    receiptId: string;
    canonicalTaskId?: string;
    canonicalTaskUrl?: string;
  }): IntakeReceipt {
    const receipt = this.requireReceiptById(params.receiptId);
    const disposition = receipt.requestedDisposition ?? receipt.disposition;
    if (!disposition || !isRemoteDisposition(disposition)) {
      return receipt;
    }
    const canonicalTaskId = params.canonicalTaskId ?? receipt.canonicalTaskId;
    const canonicalTaskUrl = params.canonicalTaskUrl ?? receipt.canonicalTaskUrl;
    if (!canonicalTaskId && !canonicalTaskUrl) {
      return receipt;
    }
    if (receipt.disposition && (receipt.canonicalTaskId || receipt.canonicalTaskUrl)) {
      return receipt;
    }
    const update = compileSqliteQueryBindings<{
      id: string;
      disposition: NonNullable<IntakeReceipt["disposition"]>;
      canonicalTaskId: string | null;
      canonicalTaskUrl: string | null;
    }>((p) =>
      this.query
        .updateTable("intake_receipts")
        .set({
          disposition: p((row) => row.disposition),
          canonical_task_id: p((row) => row.canonicalTaskId),
          canonical_task_url: p((row) => row.canonicalTaskUrl),
        })
        .where(
          "id",
          "=",
          p((row) => row.id),
        )
        .where("disposition", "is", null),
    );
    this.db.prepare(update.compiled.sql).run(
      ...update.bind({
        id: receipt.id,
        disposition,
        canonicalTaskId: canonicalTaskId ?? null,
        canonicalTaskUrl: canonicalTaskUrl ?? null,
      }),
    );
    return this.requireReceiptById(receipt.id);
  }

  protected formatCloseAcknowledgement(
    envelope: IntakeEnvelope,
    receipts: IntakeReceipt[],
  ): string {
    return buildAcknowledgement({ envelope, receipts }).text;
  }

  protected persistReplayConflict(params: {
    receiptId: string;
    envelopeId: string;
    idempotencyKey: string;
    stored: string;
    received: string;
  }): void {
    const update = compileSqliteQueryBindings<{ id: string; conflict: string }>((p) =>
      this.query
        .updateTable("intake_receipts")
        .set({
          conflict: p((row) => row.conflict),
        })
        .where(
          "id",
          "=",
          p((row) => row.id),
        ),
    );
    this.db
      .prepare(update.compiled.sql)
      .run(...update.bind({ id: params.receiptId, conflict: params.received }));
    this.insertAlert({
      envelopeId: params.envelopeId,
      receiptId: params.receiptId,
      kind: "replay_conflict",
      message: boundAlertMessage(
        `conflict ${params.idempotencyKey}: stored ${params.stored}; received ${params.received}`,
      ),
    });
  }

  protected applyDispositionRow(params: {
    id: string;
    input: IntakeDispositionInput;
    pendingRemote: boolean;
  }): void {
    const update = compileSqliteQueryBindings<
      IntakeDispositionInput & { id: string; pendingRemote: number }
    >((p) =>
      this.query
        .updateTable("intake_receipts")
        .set({
          requested_disposition: p((row) => row.disposition),
          disposition: p((row) => (row.pendingRemote ? null : row.disposition)),
          disposition_reason: p((row) => row.reason ?? null),
          canonical_task_id: p((row) => row.canonicalTaskId ?? null),
          canonical_task_url: p((row) => row.canonicalTaskUrl ?? null),
          review_owner: p((row) => row.reviewOwner ?? null),
          review_deadline_ms: p((row) => row.reviewDeadlineMs ?? null),
          turn_id: p((row) => row.turnId ?? null),
        })
        .where(
          "id",
          "=",
          p((row) => row.id),
        )
        .where("disposition", "is", null),
    );
    const changed = this.db.prepare(update.compiled.sql).run(
      ...update.bind({
        ...params.input,
        id: params.id,
        pendingRemote: params.pendingRemote ? 1 : 0,
      }),
    );
    if (Number(changed.changes ?? 0) !== 1) {
      throw new Error(`intake receipt ${params.id} disposition raced`);
    }
  }

  protected settleExistingRemoteOutbox(receiptId: string, now: number): void {
    const update = compileSqliteQueryBindings<{ receiptId: string; now: number }>((p) =>
      this.query
        .updateTable("intake_outbox")
        .set({
          status: "delivered",
          delivered_at_ms: p((row) => row.now),
          updated_at_ms: p((row) => row.now),
          last_error: null,
        })
        .where(
          "receipt_id",
          "=",
          p((row) => row.receiptId),
        )
        .where("kind", "in", ["notion_create", "notion_link", "notion_update"])
        .where("status", "in", ["pending", "in_flight"]),
    );
    this.db.prepare(update.compiled.sql).run(...update.bind({ receiptId, now }));
  }

  protected enqueueRemoteOutbox(params: {
    receipt: IntakeReceipt;
    input: IntakeDispositionInput;
    now: number;
  }): void {
    const kind = outboxKindForDisposition(params.input.disposition);
    if (!kind) {
      return;
    }
    const envelope = this.requireEnvelope(params.receipt.envelopeId);
    const insertOutbox = compileSqliteQueryBindings<{
      id: string;
      receiptId: string | null;
      envelopeId: string | null;
      kind: IntakeOutboxKind;
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
          kind: p((row) => row.kind),
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
    this.db.prepare(insertOutbox.compiled.sql).run(
      ...insertOutbox.bind({
        id: randomUUID(),
        receiptId: params.receipt.id,
        envelopeId: params.receipt.envelopeId,
        kind,
        nextAttemptAtMs: params.now,
        payloadJson: JSON.stringify({
          disposition: params.input.disposition,
          intakeIdempotencyKey: params.receipt.idempotencyKey,
          canonicalTaskId: params.input.canonicalTaskId ?? null,
          canonicalTaskUrl: params.input.canonicalTaskUrl ?? null,
          requestText: params.receipt.requestText,
          boardId: envelope.boardId,
          notionDataSourceId: params.input.notionDataSourceId ?? null,
          channel: envelope.channel,
          accountId: envelope.accountId ?? null,
          peerId: envelope.peerId ?? null,
          sessionKey: envelope.sessionKey ?? null,
          messageId: envelope.messageId,
        }),
        idempotencyKey: buildOutboxIdempotencyKey({
          kind,
          receiptId: params.receipt.id,
        }),
        createdAtMs: params.now,
      }),
    );
  }
}
