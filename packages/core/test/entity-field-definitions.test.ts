import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

describe("runtime entity field definitions", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Awaited<ReturnType<typeof createTestServer>>["kernel"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer({
      entities: {
        product: {
          fields: [
            {
              name: "material",
              type: "select",
              options: ["cotton", "linen"],
              filterable: false,
            },
            { name: "weight", type: "number" },
          ],
          variants: { enabled: false },
          fulfillment: "physical",
        },
        course: {
          fields: [],
          variants: { enabled: false },
          fulfillment: "digital-access",
        },
      },
    });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function createDefinition(body: Record<string, unknown>) {
    return makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/admin/entity-field-definitions",
      body,
      actor: testActor,
    });
  }

  async function createEntity(
    customFields: Record<string, unknown>,
    type = "product",
  ) {
    return makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type,
        slug: `${type}-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        status: "active",
        customFields,
      },
      actor: testActor,
    });
  }

  it("round-trips list, create, update, and archive over admin REST", async () => {
    const createdResponse = await createDefinition({
      entityType: "product",
      name: "fit",
      type: "select",
      unit: "size",
      options: ["slim", "relaxed"],
      target: "variant",
      filterable: true,
      localized: true,
      sortOrder: 4,
    });
    expect(createdResponse.status).toBe(201);
    const created = (
      await parseJsonResponse<{ data: Record<string, unknown> }>(
        createdResponse,
      )
    ).data;
    expect(created).toMatchObject({
      entityType: "product",
      name: "fit",
      type: "select",
      unit: "size",
      options: ["slim", "relaxed"],
      target: "variant",
      filterable: true,
      localized: true,
      status: "active",
      sortOrder: 4,
    });

    const listed = await parseJsonResponse<{
      data: Array<Record<string, unknown>>;
    }>(
      await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/admin/entity-field-definitions?entityType=product",
        actor: testActor,
      }),
    );
    expect(listed.data).toContainEqual(
      expect.objectContaining({ id: created.id, name: "fit" }),
    );

    const updatedResponse = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/admin/entity-field-definitions/${created.id}`,
      body: {
        options: ["slim", "relaxed", "oversized"],
        filterable: false,
        localized: false,
        sortOrder: 2,
      },
      actor: testActor,
    });
    expect(updatedResponse.status).toBe(200);
    expect(
      (
        await parseJsonResponse<{ data: Record<string, unknown> }>(
          updatedResponse,
        )
      ).data,
    ).toMatchObject({
      options: ["slim", "relaxed", "oversized"],
      filterable: false,
      localized: false,
      sortOrder: 2,
    });

    const archivedResponse = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/admin/entity-field-definitions/${created.id}/archive`,
      actor: testActor,
    });
    expect(archivedResponse.status).toBe(200);
    expect(
      (
        await parseJsonResponse<{ data: Record<string, unknown> }>(
          archivedResponse,
        )
      ).data.status,
    ).toBe("archived");
  });

  it("validates runtime writes with the same type and option rules as code fields", async () => {
    const definitionResponse = await createDefinition({
      entityType: "product",
      name: "fit",
      type: "select",
      options: ["slim", "relaxed"],
    });
    expect(definitionResponse.status).toBe(201);

    const runtimeInvalid = await createEntity({ fit: "tailored" });
    expect(runtimeInvalid.status).toBe(422);

    const codeInvalid = await createEntity({ material: "wool" });
    expect(codeInvalid.status).toBe(422);

    const valid = await createEntity({ fit: "  slim  ", material: "linen" });
    expect(valid.status).toBe(201);
    const entity = (await parseJsonResponse<{ data: { id: string } }>(valid))
      .data;
    const fields =
      await kernel.services.catalog.repository.findCustomFieldsByEntityId(
        entity.id,
      );
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldName: "fit",
          fieldType: "select",
          textValue: "slim",
        }),
        expect.objectContaining({
          fieldName: "material",
          fieldType: "select",
          textValue: "linen",
        }),
      ]),
    );
  });

  it("rejects archiving a code-defined field", async () => {
    const response = await createDefinition({
      entityType: "product",
      name: "material",
      type: "select",
      options: ["cotton", "linen"],
    });
    expect(response.status).toBe(201);
    const definition = (
      await parseJsonResponse<{ data: { id: string } }>(response)
    ).data;

    const archived = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/admin/entity-field-definitions/${definition.id}/archive`,
      actor: testActor,
    });
    expect(archived.status).toBe(422);
  });

  it("shadow rows over a code field inherit omitted code values instead of resetting them", async () => {
    const shadow = await createDefinition({
      entityType: "product",
      name: "material",
      type: "select",
    });
    expect(shadow.status).toBe(201);

    const outOfVocabulary = await createEntity({ material: "wool" });
    expect(outOfVocabulary.status).toBe(422);

    const mismatchedType = await createDefinition({
      entityType: "product",
      name: "weight",
      type: "text",
    });
    expect(mismatchedType.status).toBe(422);
  });

  it("blocks new writes after runtime archive while preserving existing values", async () => {
    const definitionResponse = await createDefinition({
      entityType: "product",
      name: "season",
      type: "text",
    });
    const definition = (
      await parseJsonResponse<{ data: { id: string } }>(definitionResponse)
    ).data;
    const existingResponse = await createEntity({ season: "summer" });
    expect(existingResponse.status).toBe(201);
    const existing = (
      await parseJsonResponse<{ data: { id: string } }>(existingResponse)
    ).data;

    const archiveResponse = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/admin/entity-field-definitions/${definition.id}/archive`,
      actor: testActor,
    });
    expect(archiveResponse.status).toBe(200);

    const newWrite = await createEntity({ season: "winter" });
    expect(newWrite.status).toBe(422);
    const stored =
      await kernel.services.catalog.repository.findCustomFieldByName(
        existing.id,
        "season",
      );
    expect(stored).toEqual(expect.objectContaining({ textValue: "summer" }));
  });

  it("enforces uniqueness by organization and entity type", async () => {
    const product = await createDefinition({
      entityType: "product",
      name: "shared",
      type: "text",
    });
    expect(product.status).toBe(201);

    const duplicate = await createDefinition({
      entityType: "product",
      name: "shared",
      type: "number",
    });
    expect([409, 422]).toContain(duplicate.status);

    const otherType = await createDefinition({
      entityType: "course",
      name: "shared",
      type: "number",
    });
    expect(otherType.status).toBe(201);
  });

  it("uses runtime filterable definitions when building search documents", async () => {
    const definitionResponse = await createDefinition({
      entityType: "product",
      name: "searchable",
      type: "text",
      filterable: true,
    });
    expect(definitionResponse.status).toBe(201);
    const entityResponse = await createEntity({ searchable: "runtime-value" });
    expect(entityResponse.status).toBe(201);

    const result = await kernel.services.search.query({
      query: "",
      filters: { type: "product", attributes: { searchable: "runtime-value" } },
    }, { actor: testActor, tx: null, requestId: "entity-field-search" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.hits[0]?.document.attributes).toEqual({
      searchable: "runtime-value",
    });
  });
});
