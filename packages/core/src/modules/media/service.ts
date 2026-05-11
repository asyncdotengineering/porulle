import { resolveOrgId } from "../../auth/org.js";
import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
import type { StorageAdapter, StoredFile } from "./adapter.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import {
  CommerceNotFoundError,
  CommerceValidationError,
} from "../../kernel/errors.js";
import type { MediaRepository } from "./repository/index.js";
import type { CatalogRepository } from "../catalog/repository/index.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import { makeId } from "../../utils/id.js";

export interface UploadMediaInput {
  filename: string;
  contentType: string;
  data: ArrayBuffer;
  alt?: string;
  metadata?: Record<string, unknown>;
}

export interface AttachMediaInput {
  entityId: string;
  mediaAssetId: string;
  role: "primary" | "gallery" | "thumbnail" | "video" | "document";
  variantId?: string;
  sortOrder?: number;
}

interface MediaServiceDeps {
  repository: MediaRepository;
  catalogRepository: CatalogRepository;
  storage: StorageAdapter;
  config: CommerceConfig;
}

const DEFAULT_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
];

function isSvgOrXml(buffer: Uint8Array): boolean {
  const prefix = new TextDecoder()
    .decode(buffer.slice(0, 256))
    .trimStart()
    .toLowerCase();
  return prefix.startsWith("<?xml") || prefix.startsWith("<svg");
}

export function detectMimeFromBuffer(buffer: Uint8Array): string | null {
  if (buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return "image/png";

  if (buffer.length >= 3 &&
    buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  ) return "image/jpeg";

  if (buffer.length >= 6 &&
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61
  ) return "image/gif";

  if (buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return "image/webp";

  if (buffer.length >= 4 &&
    buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46
  ) return "application/pdf";

  return null;
}

export class MediaService {
  private readonly repo: MediaRepository;
  private readonly catalogRepo: CatalogRepository;

  constructor(private deps: MediaServiceDeps) {
    this.repo = deps.repository;
    this.catalogRepo = deps.catalogRepository;
  }

  async upload(
    input: UploadMediaInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ id: string; url: string }>> {
    if (!input.filename || !input.contentType) {
      return Err(
        new CommerceValidationError("filename and contentType are required."),
      );
    }

    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const bytes = new Uint8Array(input.data);
    const detectedMime = detectMimeFromBuffer(bytes);
    const allowSvg = this.deps.config.media?.allowSvg === true;
    const allowedMimeTypes = this.deps.config.media?.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES;
    if (isSvgOrXml(bytes) && !allowSvg) {
      return Err(new CommerceValidationError("SVG uploads are disabled."));
    }
    if (detectedMime && input.contentType !== detectedMime) {
      return Err(
        new CommerceValidationError(
          `Content type mismatch — declared ${input.contentType}, detected ${detectedMime}.`,
        ),
      );
    }
    const effectiveMime = detectedMime ?? input.contentType;
    if (!allowedMimeTypes.includes(effectiveMime)) {
      return Err(
        new CommerceValidationError(`Unsupported content type: ${effectiveMime}.`),
      );
    }

    const id = makeId();
    const key = `${new Date().getFullYear()}/${id}-${input.filename}`;
    const uploaded = await this.deps.storage.upload(
      key,
      input.data,
      effectiveMime,
    );
    if (!uploaded.ok) return uploaded as Result<never>;

    await this.repo.createAsset(
      {
        organizationId: orgId,
        id,
        storageKey: key,
        filename: input.filename,
        contentType: effectiveMime,
        size: input.data.byteLength,
        metadata: input.metadata ?? {},
        uploadedAt: new Date(),
        ...(input.alt !== undefined ? { alt: input.alt } : {}),
      },
      ctx,
    );

    const url = await this.deps.storage.getUrl(key);
    if (!url.ok) return url as Result<never>;

    return Ok({ id, url: url.value });
  }

  // VAPT r2 (codex) finding: getUrl/getSignedUrl/delete loaded media by
  // global id with no actor/org filter even though the repo accepts orgId.
  // A tenant who knew or guessed a media UUID could read or delete another
  // tenant's assets — same class as the prior catalog CRITICAL-2 fix.
  // All three now resolve the actor's org and pass it to findAssetById,
  // and delete additionally requires the actor to pass cross-tenant
  // ownership (any actor without *:* must be in the asset's org).
  async getUrl(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<string>> {
    const orgId = resolveOrgId(actor ?? null);
    const asset = await this.repo.findAssetById(id, ctx, orgId);
    if (!asset) return Err(new CommerceNotFoundError("Media asset not found."));
    return this.deps.storage.getUrl(asset.storageKey);
  }

  async getSignedUrl(
    id: string,
    expiresIn = 60 * 15,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<string>> {
    const orgId = resolveOrgId(actor ?? null);
    const asset = await this.repo.findAssetById(id, ctx, orgId);
    if (!asset) return Err(new CommerceNotFoundError("Media asset not found."));
    return this.deps.storage.getSignedUrl(asset.storageKey, expiresIn);
  }

  async delete(
    id: string,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const orgId = resolveOrgId(actor ?? null);
    const asset = await this.repo.findAssetById(id, ctx, orgId);
    if (!asset) return Err(new CommerceNotFoundError("Media asset not found."));

    const deleted = await this.deps.storage.delete(asset.storageKey);
    if (!deleted.ok) return deleted;

    await this.repo.removeAllMediaByAssetId(id, ctx);
    await this.repo.deleteAsset(id, ctx);
    return Ok(undefined);
  }

  async list(prefix = ""): Promise<Result<StoredFile[]>> {
    const listed = await this.deps.storage.list(prefix);
    if (!listed.ok) return listed;
    return Ok(listed.value);
  }

  async attachToEntity(
    input: AttachMediaInput,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    const entity = await this.catalogRepo.findEntityById(input.entityId, ctx, orgId);
    if (!entity) {
      return Err(new CommerceNotFoundError("Entity not found."));
    }

    const asset = await this.repo.findAssetById(input.mediaAssetId, ctx, orgId);
    if (!asset) {
      return Err(new CommerceNotFoundError("Media asset not found."));
    }

    await this.repo.createEntityMedia(
      {
        entityId: input.entityId,
        mediaAssetId: input.mediaAssetId,
        role: input.role,
        sortOrder: input.sortOrder ?? 0,
        ...(input.variantId !== undefined
          ? { variantId: input.variantId }
          : {}),
      },
      ctx,
    );

    return Ok(undefined);
  }
}
