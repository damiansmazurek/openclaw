import { describe, expect, it } from "vitest";
import { matchIntakeBoard, resolveIntakeLedgerConfig } from "./config.js";

describe("intake ledger config", () => {
  it("parses boards and implementation worker ids", () => {
    const config = resolveIntakeLedgerConfig({
      boards: [
        {
          id: "mol-board",
          channel: "whatsapp",
          peerIds: ["mol-board@g.us"],
          unresolvedAlertAfterMs: 5_000,
        },
        { channel: "missing-id" },
      ],
      implementationAgentIds: ["jarvis-mol-v2-worker", "jarvis-mol-v2-worker"],
    });
    expect(config.boards).toEqual([
      {
        id: "mol-board",
        channel: "whatsapp",
        accountId: undefined,
        peerIds: ["mol-board@g.us"],
        notionDataSourceId: undefined,
        automationJobId: undefined,
        unresolvedAlertAfterMs: 5_000,
      },
    ]);
    expect(config.implementationAgentIds).toEqual(["jarvis-mol-v2-worker"]);
  });

  it("matches a configured WhatsApp peer and ignores unrelated chats", () => {
    const config = resolveIntakeLedgerConfig({
      boards: [{ id: "mol-board", channel: "whatsapp", peerIds: ["mol-board@g.us"] }],
    });
    expect(
      matchIntakeBoard(config.boards, {
        channelId: "whatsapp",
        peerIds: ["mol-board@g.us"],
      })?.id,
    ).toBe("mol-board");
    expect(
      matchIntakeBoard(config.boards, {
        channelId: "whatsapp",
        peerIds: ["unrelated@g.us"],
      }),
    ).toBeUndefined();
  });
});
