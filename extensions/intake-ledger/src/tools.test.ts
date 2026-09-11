import { describe, expect, it } from "vitest";
import { createIntakeFixture, sampleSource } from "./test-harness.js";
import { createIntakeLedgerTools, INTAKE_LEDGER_TOOL_NAMES } from "./tools.js";

describe("intake ledger tools", () => {
  it("hides unresolved intake from the implementation worker", async () => {
    const { service, config } = createIntakeFixture();
    const envelope = service.persistEnvelope(sampleSource({ messageId: "tools-worker" }));
    service.recordRequests({
      envelopeId: envelope.id,
      requests: [
        { requestIndex: 0, requestText: "Ready task" },
        { requestIndex: 1, requestText: "Needs review" },
      ],
    });
    service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 0,
      disposition: "linked_existing",
      canonicalTaskId: "canonical-1",
    });
    service.recordDisposition({
      envelopeId: envelope.id,
      requestIndex: 1,
      disposition: "needs_clarification",
      reason: "missing expected behavior",
    });
    const tools = createIntakeLedgerTools({
      service,
      config,
      context: { agentId: "jarvis-mol-v2-worker" } as never,
    });
    expect(tools.map((tool) => tool.name)).toEqual(["intake_ledger_canonical_ready"]);
    const result = await tools[0]!.execute("call-1", {});
    expect(result.details).toEqual({
      tasks: [
        {
          receiptId: expect.any(String),
          disposition: "linked_existing",
          canonicalTaskId: "canonical-1",
          canonicalTaskUrl: undefined,
          requestText: "Ready task",
        },
      ],
    });
  });

  it("exposes the full intake surface to the board owner", () => {
    const { service, config } = createIntakeFixture();
    const tools = createIntakeLedgerTools({
      service,
      config,
      context: { agentId: "main" } as never,
    });
    expect(tools.map((tool) => tool.name)).toEqual([...INTAKE_LEDGER_TOOL_NAMES]);
  });
});
