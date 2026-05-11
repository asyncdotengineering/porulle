import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Err, Ok, type Result, type StorageAdapter } from "@porulle/core";

interface StoredFile {
  key: string;
  url: string;
  contentType: string;
  size?: number;
}

export interface LocalStorageAdapterOptions {
  basePath: string;
  baseUrl?: string;
}

/**
 * Resolves a key against basePath and verifies the result stays inside
 * basePath. Rejects path-traversal payloads like `../../etc/passwd`,
 * absolute paths, and any other input that would escape the storage root.
 *
 * Without this guard an upload with key `../../something` would write
 * outside the storage root (CVE-class: arbitrary file write).
 */
function resolveSafePath(basePath: string, key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Invalid storage key: empty");
  }
  // Reject NUL bytes, which can truncate path checks in some libc impls
  if (key.includes("\0")) {
    throw new Error("Invalid storage key: contains NUL byte");
  }
  const normalizedBase = resolve(basePath);
  const candidate = resolve(normalizedBase, key);
  // Candidate must be exactly basePath or a descendant; protect against
  // boundary-collision (e.g. base=/data, candidate=/data-evil)
  if (
    candidate !== normalizedBase &&
    !candidate.startsWith(normalizedBase + sep)
  ) {
    throw new Error(
      `Invalid storage key: path escapes storage root (${key})`,
    );
  }
  return candidate;
}

export function localStorageAdapter(options: LocalStorageAdapterOptions): StorageAdapter {
  const baseUrl = options.baseUrl ?? "http://localhost:3000/assets";

  async function ensureParent(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
  }

  return {
    providerId: "local-storage",
    async upload(key: string, data: ArrayBuffer | ReadableStream, contentType: string): Promise<Result<StoredFile>> {
      const path = resolveSafePath(options.basePath, key);
      await ensureParent(path);

      if (data instanceof ReadableStream) {
        const reader = data.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        await writeFile(path, merged);
      } else {
        await writeFile(path, Buffer.from(data));
      }

      return Ok({
        key,
        url: `${baseUrl}/${key}`,
        contentType,
      });
    },

    async getUrl(key: string): Promise<Result<string>> {
      return Ok(`${baseUrl}/${key}`);
    },

    async getSignedUrl(key: string, expiresIn: number): Promise<Result<string>> {
      return Ok(`${baseUrl}/${key}?expiresIn=${expiresIn}`);
    },

    async delete(key: string): Promise<Result<void>> {
      const path = resolveSafePath(options.basePath, key);
      await rm(path, { force: true });
      return Ok(undefined);
    },

    async list(prefix: string): Promise<Result<StoredFile[]>> {
      const folder = resolveSafePath(options.basePath, prefix);
      try {
        const files = await readdir(folder, { recursive: true }) as string[];
        const output: StoredFile[] = [];

        for (const file of files) {
          const filePath = join(folder, file);
          const info = await stat(filePath);
          if (info.isDirectory()) continue;

          const content = await readFile(filePath);
          output.push({
            key: file,
            url: `${baseUrl}/${prefix}/${file}`,
            contentType: "application/octet-stream",
            size: content.byteLength,
          });
        }

        return Ok(output);
      } catch (error) {
        return Err({
          code: "LIST_FAILED",
          message: error instanceof Error ? error.message : "Failed to list files.",
        });
      }
    },
  };
}
