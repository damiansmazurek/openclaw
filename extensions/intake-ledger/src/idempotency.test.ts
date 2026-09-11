import { describe, expect, it } from "vitest";
import { buildIntakeIdempotencyKey, parseIntakeIdempotencyKey } from "./idempotency.js";

describe("intake idempotency keys", () => {
  it("is deterministic across channel, message id, and request index", () => {
    const key = buildIntakeIdempotencyKey({
      channel: "whatsapp",
      messageId: "3BD6DCADA2836AC6FE60",
      requestIndex: 3,
    });
    expect(key).toBe("whatsapp:3BD6DCADA2836AC6FE60:3");
    expect(parseIntakeIdempotencyKey(key)).toEqual({
      channel: "whatsapp",
      messageId: "3BD6DCADA2836AC6FE60",
      requestIndex: 3,
    });
  });
});
