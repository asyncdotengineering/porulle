/**
 * Currencies whose minor unit IS the major unit (ISO 4217 exponent 0), so an
 * amount of 1500 JPY is stored as 1500, not 150000.
 *
 * ponytail: zero- vs two-decimal only. Three-decimal currencies (KWD, BHD, OMR,
 * JOD, TND) are treated as two-decimal everywhere in core; give them exponent 3
 * here once pricing and documents are audited for it.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/** Number of minor-unit digits for an ISO 4217 code: 0 for JPY, 2 for USD. */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase()) ? 0 : 2;
}

/**
 * A major-unit amount ("15.00", 15) as integer minor units in `currency`.
 * Blank or non-numeric input answers `undefined` rather than 0, so a missing
 * price is never mistaken for a free one.
 */
export function toMinorUnits(
  amount: string | number | null | undefined,
  currency: string,
): number | undefined {
  if (amount == null) return undefined;
  if (typeof amount === "string" && amount.trim() === "") return undefined;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 10 ** currencyExponent(currency));
}

/** Minor units → "1,234.50 LKR" (or "1,500 JPY"). */
export function formatAmount(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const formatted = (minor / 10 ** exponent).toLocaleString("en-US", {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  });
  return `${formatted} ${currency}`;
}

/** An ISO 4217 code as stored: trimmed and upper-cased. */
export function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}
