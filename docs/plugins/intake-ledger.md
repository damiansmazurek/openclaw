---
summary: "Durable request-intake ledger with atomic receipts, explicit dispositions, and reconciliation"
read_when:
  - You are enabling lossless inbound request intake for a configured board
  - You need explicit terminal dispositions before a turn can close
  - You want unresolved-request audit, outbox retry, or retained-history backfill
title: "Intake Ledger plugin"
---

The Intake Ledger plugin is an OpenClaw-owned durable store for inbound
request intake. It is separate from model context, semantic memory, and any
product-code worker. Configured boards persist a source envelope and atomic
request receipts before canonical lookup. Every receipt needs one visible
terminal disposition. Notion writes and acknowledgements retry through an
outbox. A reconciler alerts on unresolved entries.

The plugin is bundled and disabled by default.

## What it stores

The ledger keeps only what an audit needs:

- Source reference: board, channel, message id, sender id, timestamps
- Atomic request text
- Requested remote work, confirmed terminal disposition, canonical-task
  linkage, and outbox/retry state

It does not store unrelated chat content. Persisted adapter errors and alerts
are bounded and redacted.

## Terminal dispositions

Each atomic request must end in exactly one of:

| Disposition              | Meaning                                         |
| ------------------------ | ----------------------------------------------- |
| `created_new`            | A new canonical task was created                |
| `linked_existing`        | The request extended an existing canonical task |
| `completed`              | The request was already done                    |
| `needs_clarification`    | Functional clarification is required            |
| `not_actioned`           | Explicitly not actioned, with a reason          |
| `needs_canonical_review` | Duplicate match is ambiguous and stays visible  |

`created_new`, `linked_existing`, and `completed` stay **requested remote
work** until a confirmed canonical task id or URL is recorded. Completeness
counts confirmed terminal rows only. Recording a confirmed result does not
enqueue a second Notion mutation. `linked_existing` requires that canonical
reference up front. `not_actioned` and `needs_clarification` require a reason.
`needs_canonical_review` requires `reviewOwner` and `reviewDeadlineMs`.

A tool error or “search later” is not terminal. Completeness fails until the
extracted request count equals the confirmed disposition count. The natural
final reply must include the extracted count plus every task link or
non-action reason. After two revision attempts the ledger delivers that
acknowledgement through the outbound outbox and never silently closes an
incomplete turn.

## Enable

```json5
{
  plugins: {
    entries: {
      "intake-ledger": {
        enabled: true,
        config: {
          boards: [
            {
              id: "product-board",
              channel: "whatsapp",
              peerIds: ["<group-id>"],
              notionDataSourceId: "<data-source-id>",
              automationJobId: "intake-notion-handoff",
              unresolvedAlertAfterMs: 3600000,
            },
          ],
          implementationAgentIds: ["implementation-worker"],
        },
      },
    },
  },
  channels: {
    whatsapp: {
      pluginHooks: { messageReceived: true },
    },
  },
}
```

WhatsApp `message_received` hooks are off by default. Enable
`channels.whatsapp.pluginHooks.messageReceived` so the ledger can persist
envelopes when inbound messages arrive.

When the plugin is enabled, the intake tools are on the default tool surface.
Do not mark them optional: `before_tool_call` blocks non-ledger tools until
`intake_ledger_record_requests` runs, so an optional allowlist would deadlock
the turn.

State lives at `<state-dir>/plugins/intake-ledger/intake-ledger.sqlite`.

## Delivery and Notion handoff

Reply acknowledgements and alerts send through the channel outbound adapter
(`runtime.channel.outbound.loadAdapter(channel).sendText`) using durable
routing facts stored on the envelope: channel, account, peer, and session.
`message_sent` success that already contains the acknowledgement settles the
`reply_ack` outbox; failure keeps it for retry.

There is no in-process Notion client. Notion outbox items use a
claim/complete/fail protocol:

1. The reconciler claims the row (new claim token) and nudges the configured
   Gateway cron job with `cron.run` `{ id, mode: "if-enabled" }` and
   `operator.admin`.
2. The job must reconcile by the intake idempotency key before create, then
   complete with `intake_ledger_ack_delivery` or
   `openclaw intake-ledger complete --idempotency-key <key> --remote-id <id> --claim-token <token>`.
3. A missing adapter, missing `automationJobId`, or disabled cron job is a
   **bounded configuration failure** (`retryable: false`) plus an alert. It
   does not retry forever.

Create the cron job with the Gateway cron owner, then set
`boards[].automationJobId` (or top-level `automationJobId`) to that job id.
The job payload should use the stored intake idempotency key, request text,
and `notionDataSourceId`.

Stuck in-flight Notion rows may retry because the intake idempotency key is
the remote create key. Stuck reply/alert sends are marked reviewable instead
of blindly resent.

## Tools

Board-owner turns can call:

- `intake_ledger_record_requests` — persist atomic receipts before lookup
- `intake_ledger_disposition` — record one disposition per receipt
- `intake_ledger_audit` — list unresolved entries with source timestamps
- `intake_ledger_ack_delivery` — complete a claimed Notion or reply delivery
- `intake_ledger_backfill` — audit retained requests against canonical evidence
- `intake_ledger_canonical_ready` — created or linked canonical tasks only

Agents listed in `implementationAgentIds` see only
`intake_ledger_canonical_ready`. Unresolved intake is never product-code work.

While an envelope is pending extraction, non-ledger tools are blocked so
receipts are written before Notion or repository lookup. Every pending
envelope in the session is blocked in received order.

## CLI

```bash
openclaw intake-ledger unresolved --json
openclaw intake-ledger audit
openclaw intake-ledger reconcile
openclaw intake-ledger complete --idempotency-key <key> --remote-id <id> --claim-token <token>
openclaw intake-ledger canonical --board product-board
```

## Recovery

If a turn dies after receipts are written, the receipts remain. The reconciler
retries due outbox items, recovers interrupted in-flight Notion handoffs, and
opens alerts for ageing unresolved entries. Repeat delivery of the same channel
message id is idempotent. Changed request text or disposition fields for the
same idempotency key are stored as explicit conflicts, not silent replays.
