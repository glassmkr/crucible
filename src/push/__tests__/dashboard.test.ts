import { describe, expect, it } from "vitest";
import { addResponseChunkSize, MAX_PINNED_RESPONSE_BYTES } from "../dashboard.js";

describe("pinned dashboard response limits", () => {
  it("counts response bytes across chunks", () => {
    expect(addResponseChunkSize(10, Buffer.from("hello"))).toBe(15);
  });

  it("rejects a response larger than the configured cap", () => {
    expect(() => addResponseChunkSize(MAX_PINNED_RESPONSE_BYTES, "x"))
      .toThrow(/exceeded/);
  });
});
