import type { Result } from "../../kernel/result.js";

export interface StoredFile {
  key: string;
  url: string;
  contentType: string;
  size?: number;
}

export interface StorageAdapter {
  readonly providerId: string;
  upload(key: string, data: ArrayBuffer | ReadableStream, contentType: string): Promise<Result<StoredFile>>;
  getUrl(key: string): Promise<Result<string>>;
  getSignedUrl(key: string, expiresIn: number): Promise<Result<string>>;
  delete(key: string): Promise<Result<void>>;
  list(prefix: string): Promise<Result<StoredFile[]>>;
}
