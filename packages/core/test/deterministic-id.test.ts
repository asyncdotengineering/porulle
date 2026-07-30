import { describe, expect, it } from "vitest";
import { makeDeterministicId } from "../src/utils/id.js";

describe("makeDeterministicId", () => {
  it("creates a stable RFC 9562 UUIDv8 without collapsing different keys", async () => {
    const first = await makeDeterministicId("checkout:org-a:key-1");
    expect(first).toBe(await makeDeterministicId("checkout:org-a:key-1"));
    expect(first).not.toBe(await makeDeterministicId("checkout:org-a:key-2"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
