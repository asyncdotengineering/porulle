import { describe, it, expect } from "vitest";
import {
  generateGiftCardCode,
  normalizeCode,
  formatCode,
  CODE_CHARSET,
} from "../src/code-generator.js";

describe("Code Generator", () => {
  it("generates codes matching the default format XXXX-XXXX-XXXX-XXXX", () => {
    const code = generateGiftCardCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("generates codes using only the allowed charset (no ambiguous chars)", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateGiftCardCode();
      const chars = code.replace(/-/g, "");
      for (const ch of chars) {
        expect(CODE_CHARSET).toContain(ch);
      }
    }
  });

  it("never includes ambiguous characters (0, O, 1, I, L)", () => {
    const ambiguous = ["0", "O", "1", "I", "L"];
    for (let i = 0; i < 200; i++) {
      const code = generateGiftCardCode();
      for (const ch of ambiguous) {
        expect(code).not.toContain(ch);
      }
    }
  });

  it("generates unique codes (no collisions in 10000 codes)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      codes.add(generateGiftCardCode());
    }
    expect(codes.size).toBe(10000);
  });

  it("supports custom formats", () => {
    const code = generateGiftCardCode("XXXXXX");
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("preserves non-X characters in the format", () => {
    const code = generateGiftCardCode("GC-XXXX-XXXX");
    expect(code).toMatch(/^GC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  describe("normalizeCode", () => {
    it("strips hyphens and uppercases", () => {
      expect(normalizeCode("abcd-1234-efgh-5678")).toBe("ABCD1234EFGH5678");
    });

    it("strips spaces", () => {
      expect(normalizeCode("ABCD 1234 EFGH 5678")).toBe("ABCD1234EFGH5678");
    });

    it("handles already-normalized input", () => {
      expect(normalizeCode("ABCD1234EFGH5678")).toBe("ABCD1234EFGH5678");
    });
  });

  describe("formatCode", () => {
    it("formats raw code into display format", () => {
      expect(formatCode("ABCD1234EFGH5678")).toBe("ABCD-1234-EFGH-5678");
    });

    it("handles custom formats", () => {
      expect(formatCode("ABCDEF", "XXX-XXX")).toBe("ABC-DEF");
    });
  });
});
