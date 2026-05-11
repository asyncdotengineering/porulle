import { webcrypto } from "node:crypto";

// Polyfill globalThis.crypto for Node 18 environments (vitest uses node environment
// which doesn't expose Web Crypto API on globalThis by default before Node 19).
if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}
