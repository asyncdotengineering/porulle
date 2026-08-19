import type { SellableEntityRevisionSnapshot } from "./schema.js";

export function canonicalSerialize(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Row bookkeeping timestamps are excluded from comparison only at row roots,
// never inside nested jsonb where a user key may share the same name.
function stripRowTimestamps(row: Record<string, unknown>): Record<string, unknown> {
  const { createdAt, updatedAt, ...rest } = row;
  void createdAt;
  void updatedAt;
  return rest;
}

export function comparableSerialize(snapshot: SellableEntityRevisionSnapshot): string {
  return canonicalSerialize({
    entity: stripRowTimestamps(snapshot.entity),
    attributes: snapshot.attributes.map(stripRowTimestamps),
    customFields: snapshot.customFields.map(stripRowTimestamps),
    media: snapshot.media.map(stripRowTimestamps),
    categories: snapshot.categories.map(stripRowTimestamps),
    brands: snapshot.brands.map(stripRowTimestamps),
    tags: (snapshot.tags ?? []).map(stripRowTimestamps),
  });
}
