import { Err, Ok, type Result, type StorageAdapter } from "@porulle/core";

export interface R2ObjectEntry {
  key: string;
  size: number;
  httpMetadata?: {
    contentType?: string;
  };
}

export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
    },
  ): Promise<unknown>;
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: {
      contentType?: string;
    };
  } | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: R2ObjectEntry[] }>;
}

export interface R2StorageAdapterOptions {
  bucket: R2BucketLike;
  bucketName: string;
  publicBaseUrl?: string;
  signedUrl?: (key: string, expiresIn: number) => Promise<string>;
}

async function toArrayBuffer(data: ArrayBuffer | ReadableStream): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return data;
  return new Response(data).arrayBuffer();
}

function urlFor(options: R2StorageAdapterOptions, key: string): string {
  if (options.publicBaseUrl) {
    return `${options.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }
  return `r2://${options.bucketName}/${key}`;
}

export function r2StorageAdapter(options: R2StorageAdapterOptions): StorageAdapter {
  return {
    providerId: "r2",

    async upload(key, data, contentType): Promise<Result<{ key: string; url: string; contentType: string; size?: number }>> {
      try {
        const body = await toArrayBuffer(data);
        await options.bucket.put(key, body, {
          httpMetadata: {
            contentType,
          },
        });

        return Ok({
          key,
          url: urlFor(options, key),
          contentType,
          size: body.byteLength,
        });
      } catch (error) {
        return Err({
          code: "R2_UPLOAD_FAILED",
          message: error instanceof Error ? error.message : "Failed to upload object to R2.",
        });
      }
    },

    async getUrl(key): Promise<Result<string>> {
      return Ok(urlFor(options, key));
    },

    async getSignedUrl(key, expiresIn): Promise<Result<string>> {
      try {
        if (options.signedUrl) {
          const url = await options.signedUrl(key, expiresIn);
          return Ok(url);
        }

        const base = urlFor(options, key);
        return Ok(`${base}?expiresIn=${expiresIn}`);
      } catch (error) {
        return Err({
          code: "R2_SIGNED_URL_FAILED",
          message: error instanceof Error ? error.message : "Failed to create R2 signed URL.",
        });
      }
    },

    async delete(key): Promise<Result<void>> {
      try {
        await options.bucket.delete(key);
        return Ok(undefined);
      } catch (error) {
        return Err({
          code: "R2_DELETE_FAILED",
          message: error instanceof Error ? error.message : "Failed to delete R2 object.",
        });
      }
    },

    async list(prefix): Promise<Result<Array<{ key: string; url: string; contentType: string; size?: number }>>> {
      try {
        const listed = await options.bucket.list({ prefix });
        return Ok(
          listed.objects.map((item) => ({
            key: item.key,
            url: urlFor(options, item.key),
            contentType: item.httpMetadata?.contentType ?? "application/octet-stream",
            size: item.size,
          })),
        );
      } catch (error) {
        return Err({
          code: "R2_LIST_FAILED",
          message: error instanceof Error ? error.message : "Failed to list R2 objects.",
        });
      }
    },
  };
}
