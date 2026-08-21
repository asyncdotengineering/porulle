import type { Actor } from "../auth/types.js";

export function makeId(): string {
  return crypto.randomUUID();
}

export async function makeDeterministicId(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function makeIdempotencyScope(
  actor: Actor | null | undefined,
  guestCredential?: string,
  fallbackBinding?: string,
): Promise<string> {
  const binding = actor?.userId
    ? `actor:${actor.type}:${actor.userId}`
    : guestCredential
      ? `guest:${guestCredential}`
      : fallbackBinding
        ? `resource:${fallbackBinding}`
        : "anonymous";
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
