import { randomBytes } from "node:crypto";

/**
 * Allowed characters for gift card codes.
 * Excludes visually ambiguous characters: 0, O, 1, I, L
 * Charset size: 30 → 30^16 ≈ 7.2 × 10^23 possible codes
 */
const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Generate a cryptographically secure gift card code.
 *
 * Format: XXXX-XXXX-XXXX-XXXX (16 alphanumeric chars)
 * Uses crypto.randomBytes for uniform distribution.
 *
 * @param format - Pattern where X is replaced with a random char. Default: "XXXX-XXXX-XXXX-XXXX"
 */
export function generateGiftCardCode(format = "XXXX-XXXX-XXXX-XXXX"): string {
  const charCount = (format.match(/X/g) ?? []).length;
  // Request extra bytes to handle modulo bias rejection
  const bytes = randomBytes(charCount * 2);

  let byteIdx = 0;
  let result = "";

  for (const ch of format) {
    if (ch === "X") {
      // Rejection sampling to avoid modulo bias
      // CHARSET.length = 30, so we reject values >= 240 (240 = 30 * 8)
      let value: number;
      do {
        if (byteIdx >= bytes.length) {
          // Extremely unlikely — generate more bytes
          const extra = randomBytes(charCount);
          for (let i = 0; i < extra.length; i++) {
            bytes[byteIdx + i] = extra[i]!;
          }
        }
        value = bytes[byteIdx++]!;
      } while (value >= 240); // 240 = 30 * 8, ensures uniform distribution

      result += CHARSET[value % CHARSET.length]!;
    } else {
      result += ch;
    }
  }

  return result;
}

/**
 * Normalize a gift card code for database lookup.
 * Strips hyphens/spaces and uppercases.
 */
export function normalizeCode(code: string): string {
  return code.replace(/[-\s]/g, "").toUpperCase();
}

/**
 * Format a raw code string into the display format.
 */
export function formatCode(raw: string, format = "XXXX-XXXX-XXXX-XXXX"): string {
  const chars = raw.replace(/[-\s]/g, "").toUpperCase();
  let charIdx = 0;
  let result = "";

  for (const ch of format) {
    if (ch === "X" && charIdx < chars.length) {
      result += chars[charIdx++];
    } else if (ch !== "X") {
      result += ch;
    }
  }

  return result;
}

/** The character set used for code generation (for validation/testing) */
export const CODE_CHARSET = CHARSET;
