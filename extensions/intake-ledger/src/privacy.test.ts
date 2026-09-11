import { describe, expect, it } from "vitest";
import { collectPeerIds, sanitizeAtomicRequests, sourceRefFromInbound } from "./privacy.js";

describe("intake privacy", () => {
  it("keeps only source identity and request text", () => {
    const source = sourceRefFromInbound({
      boardId: "mol-board",
      channel: "whatsapp",
      messageId: "3BE23ACCB3FC213E6D64",
      senderId: "benoit",
      sourceTimestampMs: 123,
    });
    expect(source).toEqual({
      boardId: "mol-board",
      channel: "whatsapp",
      accountId: undefined,
      peerId: undefined,
      messageId: "3BE23ACCB3FC213E6D64",
      senderId: "benoit",
      sourceTimestampMs: 123,
      sessionKey: undefined,
      runId: undefined,
    });
    expect(JSON.stringify(source)).not.toContain("casual chatter");
  });

  it("drops blank request text and truncates oversized request text", () => {
    const requests = sanitizeAtomicRequests([
      { requestText: "   " },
      { requestIndex: 2, requestText: `keep ${"x".repeat(5000)}` },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestIndex).toBe(2);
    expect(requests[0]?.requestText.startsWith("keep ")).toBe(true);
    expect(requests[0]?.requestText.length).toBe(4000);
  });

  it("collects peer ids from inbound metadata without retaining body text", () => {
    expect(
      collectPeerIds({
        from: "mol-board@g.us",
        metadata: { to: "mol-board@g.us", originatingTo: "ignored-body" },
      }),
    ).toEqual(["mol-board@g.us", "ignored-body"]);
  });
});
