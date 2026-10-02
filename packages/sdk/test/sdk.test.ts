import { describe, expect, it } from "vitest";
import { createClient } from "../src/index.js";

describe("createClient", () => {
  function createMockClient() {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];

    const client = createClient<Record<string, unknown>>({
      baseUrl: "https://commerce.local",
      auth: { type: "api_key", key: "test-key" },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        calls.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
        });

        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    return { client, calls };
  }

  it("sends auth header on every request", async () => {
    const { client, calls } = createMockClient();
    await client.GET("/api/catalog/entities" as never);

    expect(calls[0]?.url).toContain("/api/catalog/entities");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("x-api-key")).toBe("test-key");
  });

  it("passes query params on GET", async () => {
    const { client, calls } = createMockClient();
    await client.GET("/api/catalog/entities" as never, {
      params: { query: { type: "product", page: "1" } },
    } as never);

    expect(calls[0]?.url).toContain("type=product");
    expect(calls[0]?.url).toContain("page=1");
  });

  it("sends POST body", async () => {
    const { client, calls } = createMockClient();
    await client.POST("/api/catalog/entities" as never, {
      body: { type: "product", slug: "new-product" },
    } as never);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/api/catalog/entities");
  });
});
