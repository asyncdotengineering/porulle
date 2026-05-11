import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Err, Ok, type Result, type StorageAdapter } from "@porulle/core";

interface S3ClientLike {
  send(command: unknown): Promise<any>;
}

export interface S3StorageAdapterOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  signedUrlExpiresIn?: number;
  credentials?: S3ClientConfig["credentials"];
  client?: S3ClientLike;
  signUrl?: (client: S3ClientLike, command: unknown, options: { expiresIn: number }) => Promise<string>;
}

async function toArrayBuffer(data: ArrayBuffer | ReadableStream): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return data;
  return new Response(data).arrayBuffer();
}

function objectUrl(options: S3StorageAdapterOptions, key: string): string {
  if (options.publicBaseUrl) {
    return `${options.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  if (options.endpoint) {
    const endpoint = options.endpoint.replace(/\/$/, "");
    if (options.forcePathStyle) {
      return `${endpoint}/${options.bucket}/${key}`;
    }
    return `${endpoint}/${key}`;
  }

  return `https://${options.bucket}.s3.${options.region}.amazonaws.com/${key}`;
}

export function s3StorageAdapter(options: S3StorageAdapterOptions): StorageAdapter {
  const client: S3ClientLike =
    options.client ??
    new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });

  const signUrl = options.signUrl ?? (async (currentClient, command, config) => getSignedUrl(currentClient as any, command as any, config));

  return {
    providerId: "s3",

    async upload(key, data, contentType): Promise<Result<{ key: string; url: string; contentType: string; size?: number }>> {
      try {
        const body = await toArrayBuffer(data);

        await client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: key,
            Body: new Uint8Array(body),
            ContentType: contentType,
          }),
        );

        return Ok({
          key,
          url: objectUrl(options, key),
          contentType,
          size: body.byteLength,
        });
      } catch (error) {
        return Err({
          code: "S3_UPLOAD_FAILED",
          message: error instanceof Error ? error.message : "Failed to upload to S3.",
        });
      }
    },

    async getUrl(key): Promise<Result<string>> {
      return Ok(objectUrl(options, key));
    },

    async getSignedUrl(key, expiresIn): Promise<Result<string>> {
      try {
        const ttl = expiresIn > 0 ? expiresIn : options.signedUrlExpiresIn ?? 900;
        const url = await signUrl(
          client,
          new GetObjectCommand({
            Bucket: options.bucket,
            Key: key,
          }),
          { expiresIn: ttl },
        );

        return Ok(url);
      } catch (error) {
        return Err({
          code: "S3_SIGNED_URL_FAILED",
          message: error instanceof Error ? error.message : "Failed to generate signed URL.",
        });
      }
    },

    async delete(key): Promise<Result<void>> {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: options.bucket,
            Key: key,
          }),
        );
        return Ok(undefined);
      } catch (error) {
        return Err({
          code: "S3_DELETE_FAILED",
          message: error instanceof Error ? error.message : "Failed to delete object from S3.",
        });
      }
    },

    async list(prefix): Promise<Result<Array<{ key: string; url: string; contentType: string; size?: number }>>> {
      try {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: options.bucket,
            Prefix: prefix,
          }),
        );

        const items = (listed.Contents ?? []).map((item: any) => ({
          key: String(item.Key ?? ""),
          url: objectUrl(options, String(item.Key ?? "")),
          contentType: "application/octet-stream",
          size: typeof item.Size === "number" ? item.Size : undefined,
        }));

        return Ok(items.filter((item: { key: string }) => item.key.length > 0));
      } catch (error) {
        return Err({
          code: "S3_LIST_FAILED",
          message: error instanceof Error ? error.message : "Failed to list S3 objects.",
        });
      }
    },
  };
}
