import type { CommerceError } from "../../kernel/errors.js";
import { Ok, Err, type Result } from "../../kernel/result.js";
import type { StorageAdapter } from "./adapter.js";

const notSupported = (op: string): Result<never, CommerceError> =>
  Err({
    code: "STORAGE_NOT_SUPPORTED",
    message: `storage.${op} is disabled — no storage adapter is configured.`,
  });

/**
 * The default `StorageAdapter` used when `defineConfig` is given no `storage`.
 *
 * Lets a catalog-only deployment boot with zero storage config: read-only
 * `getUrl` passes the key through (so catalog projections keep working), while
 * the mutating media operations return a typed `STORAGE_NOT_SUPPORTED` error.
 * Configure a real adapter (local/S3/R2) to enable media.
 */
export const noopStorageAdapter: StorageAdapter = {
  providerId: "noop",
  async upload() {
    return notSupported("upload");
  },
  async getUrl(key) {
    return Ok(key);
  },
  async getSignedUrl() {
    return notSupported("getSignedUrl");
  },
  async delete() {
    return Ok(undefined);
  },
  async list() {
    return Ok([]);
  },
};
