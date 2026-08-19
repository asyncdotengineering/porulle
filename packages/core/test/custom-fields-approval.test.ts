import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

const ORG_A = "custom_field_review_a";
const ORG_B = "custom_field_review_b";

const reviewerA: Actor = {
  type: "user",
  userId: "custom-field-reviewer-a",
  email: "reviewer-a@custom-fields.test",
  name: "Reviewer A",
  vendorId: null,
  organizationId: ORG_A,
  role: "staff",
  permissions: ["catalog:create", "catalog:update", "catalog:read"],
};

const reviewerB: Actor = {
  type: "user",
  userId: "custom-field-reviewer-b",
  email: "reviewer-b@custom-fields.test",
  name: "Reviewer B",
  vendorId: null,
  organizationId: ORG_B,
  role: "staff",
  permissions: ["catalog:create", "catalog:update", "catalog:read"],
};

describe("catalog custom-field review", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createPGliteTestConfig({
      entities: {
        product: {
          fields: [{ name: "warranty", type: "text" }],
          variants: { enabled: false },
          fulfillment: "physical",
        },
      },
    });
    cleanup = built.cleanup;
    kernel = createKernel(built.config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const db = kernel.database.db as DrizzleDatabase;
    await db.insert(organization).values([
      { id: ORG_A, name: "Custom Field Review A", slug: "custom-field-review-a", createdAt: new Date() },
      { id: ORG_B, name: "Custom Field Review B", slug: "custom-field-review-b", createdAt: new Date() },
    ]).onConflictDoNothing();
  });

  async function createEntity(actor: Actor, slug: string, withApprovedValue = true) {
    const result = await kernel.services.catalog.create({
      type: "product",
      slug,
      ...(withApprovedValue ? { customFields: { warranty: "1y" } } : {}),
    }, actor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.value.id;
  }

  async function createProposal(entityId: string, value: string, evidence = "catalog-enrichment-v1") {
    return kernel.services.catalog.repository.createCustomField({
      entityId,
      fieldName: "warranty",
      fieldType: "text",
      textValue: value,
      source: "enrichment",
      status: "proposed",
      confidence: "0.912",
      evidence: { model: evidence, sourceUrl: "https://example.test/source" },
      locale: "en",
    });
  }

  it("approves a proposal by displacing the live value and records an update revision", async () => {
    const entityId = await createEntity(reviewerA, "review-approve");
    const proposal = await createProposal(entityId, "2y");

    const result = await kernel.services.catalog.approveCustomField(
      entityId,
      "warranty",
      "en",
      reviewerA,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      id: proposal.id,
      status: "approved",
      textValue: "2y",
      source: "enrichment",
      confidence: "0.912",
      evidence: { model: "catalog-enrichment-v1", sourceUrl: "https://example.test/source" },
      approvedBy: reviewerA.userId,
    });
    expect(result.value.approvedAt).toBeInstanceOf(Date);

    const fields = await kernel.services.catalog.repository.findAllCustomFieldsByEntityId(entityId);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ id: proposal.id, status: "approved", textValue: "2y" });

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(entityId);
    expect(revisions.at(-1)).toMatchObject({ reason: "update", actorId: reviewerA.userId });
  });

  it("approves the newest proposal deterministically and auto-rejects its siblings", async () => {
    const entityId = await createEntity(reviewerA, "review-multi-proposal");
    const older = await kernel.services.catalog.repository.createCustomField({
      entityId,
      fieldName: "warranty",
      fieldType: "text",
      textValue: "2y",
      source: "enrichment",
      status: "proposed",
      locale: "en",
      createdAt: new Date(Date.now() - 60_000),
    });
    const newer = await createProposal(entityId, "3y");

    const result = await kernel.services.catalog.approveCustomField(entityId, "warranty", "en", reviewerA);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({ id: newer.id, status: "approved", textValue: "3y" });

    const fields = await kernel.services.catalog.repository.findAllCustomFieldsByEntityId(entityId);
    expect(fields.find((field) => field.id === older.id)).toMatchObject({ status: "rejected" });
    expect(fields.filter((field) => field.status === "approved")).toHaveLength(1);

    const again = await kernel.services.catalog.approveCustomField(entityId, "warranty", "en", reviewerA);
    expect(again.ok).toBe(false);
  });

  it("rejects a proposal while leaving the approved value untouched and queryable", async () => {
    const entityId = await createEntity(reviewerA, "review-reject");
    const proposal = await createProposal(entityId, "9m", "rejected-value-source");

    const result = await kernel.services.catalog.rejectCustomField(
      entityId,
      "warranty",
      "en",
      reviewerA,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({ id: proposal.id, status: "rejected", textValue: "9m" });

    const approved = await kernel.services.catalog.repository.findCustomFieldsByEntityId(entityId);
    expect(approved).toEqual([expect.objectContaining({ status: "approved", textValue: "1y" })]);
    const allFields = await kernel.services.catalog.repository.findAllCustomFieldsByEntityId(entityId);
    expect(allFields).toEqual([
      expect.objectContaining({ status: "approved", textValue: "1y" }),
      expect.objectContaining({ id: proposal.id, status: "rejected", textValue: "9m", evidence: { model: "rejected-value-source", sourceUrl: "https://example.test/source" } }),
    ]);

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(entityId);
    expect(revisions.at(-1)).toMatchObject({ reason: "update", actorId: reviewerA.userId });
  });

  it("returns not found when the requested proposal does not exist", async () => {
    const entityId = await createEntity(reviewerA, "review-missing");

    const result = await kernel.services.catalog.approveCustomField(
      entityId,
      "warranty",
      "en",
      reviewerA,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("returns not found when an actor from another organization approves a proposal", async () => {
    const entityId = await createEntity(reviewerB, "review-cross-org");
    await createProposal(entityId, "2y");

    const result = await kernel.services.catalog.approveCustomField(
      entityId,
      "warranty",
      "en",
      reviewerA,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("lists proposed fields only within the requested organization with entity identity", async () => {
    const entityA = await createEntity(reviewerA, "review-queue-a", false);
    const entityB = await createEntity(reviewerB, "review-queue-b", false);
    await createProposal(entityA, "2y");
    await createProposal(entityB, "3y");
    await kernel.services.catalog.repository.createCustomField({
      entityId: entityA,
      fieldName: "warranty",
      fieldType: "text",
      textValue: "old",
      source: "enrichment",
      status: "rejected",
      locale: "en",
    });

    const listed = await kernel.services.catalog.repository.listProposedCustomFields(
      ORG_A,
      { page: 1, limit: 20 },
      { entityType: "product" },
    );

    expect(listed.total).toBe(1);
    expect(listed.items).toEqual([
      expect.objectContaining({
        entityId: entityA,
        entitySlug: "review-queue-a",
        entityType: "product",
        fieldName: "warranty",
        status: "proposed",
        textValue: "2y",
      }),
    ]);
  });
});

describe("custom-field review REST", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Awaited<ReturnType<typeof createTestServer>>["kernel"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createTestServer({
      entities: {
        product: {
          fields: [{ name: "warranty", type: "text" }],
          variants: { enabled: false },
          fulfillment: "physical",
        },
      },
    });
    server = built.server;
    kernel = built.kernel;
    cleanup = built.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function createEntity(slug: string) {
    const result = await kernel.services.catalog.create({ type: "product", slug }, testActor);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.value.id;
  }

  async function createProposal(entityId: string, value: string) {
    return kernel.services.catalog.repository.createCustomField({
      entityId,
      fieldName: "warranty",
      fieldType: "text",
      textValue: value,
      source: "enrichment",
      status: "proposed",
      confidence: "0.901",
      evidence: { model: "rest-review" },
      locale: "en",
    });
  }

  it("lists the org-scoped queue and approves a proposal", async () => {
    const entityId = await createEntity("rest-review-approve");
    const proposal = await createProposal(entityId, "2y");

    const listedResponse = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/admin/custom-field-proposals?entityType=product&page=1&limit=20",
      actor: testActor,
    });
    expect(listedResponse.status).toBe(200);
    const listed = await parseJsonResponse<{
      data: { items: Array<Record<string, unknown>>; total: number };
    }>(listedResponse);
    expect(listed.data.total).toBe(1);
    expect(listed.data.items).toEqual([
      expect.objectContaining({ id: proposal.id, entityId, entitySlug: "rest-review-approve", entityType: "product", status: "proposed" }),
    ]);

    const approvedResponse = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/custom-fields/warranty/approve?locale=en`,
      actor: testActor,
    });
    expect(approvedResponse.status).toBe(200);
    const approved = await parseJsonResponse<{ data: Record<string, unknown> }>(approvedResponse);
    expect(approved.data).toMatchObject({ id: proposal.id, status: "approved", textValue: "2y", approvedBy: testActor.userId });
  });

  it("rejects a proposal through REST with the default locale", async () => {
    const entityId = await createEntity("rest-review-reject");
    const proposal = await createProposal(entityId, "9m");

    const response = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/catalog/entities/${entityId}/custom-fields/warranty/reject`,
      actor: testActor,
    });

    expect(response.status).toBe(200);
    const rejected = await parseJsonResponse<{ data: Record<string, unknown> }>(response);
    expect(rejected.data).toMatchObject({ id: proposal.id, status: "rejected", textValue: "9m" });
  });
});
