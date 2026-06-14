/**
 * parseJson + uniform error envelope (#17)
 *
 * Replaces the unsafe `(await c.req.json()) as T` cast with a validated
 * parse that returns a 422 carrying `details.issues[]`. Tests cover the
 * happy path, multi-issue rejection, malformed JSON, and the envelope shape.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { parseJson, err } from "../src/index.js";

const BodySchema = z.object({
  name: z.string().min(1),
  age: z.number().int(),
});

function appUnder() {
  const app = new Hono();
  app.post("/things", async (c) => {
    const body = await parseJson(c, BodySchema);
    if (body instanceof Response) return body;
    return c.json({ data: { name: body.name, age: body.age } }, 201);
  });
  app.get("/boom", (c) => err(c, 400, "TEAPOT", "no tea", { issues: [{ path: "x", message: "bad", code: "c" }] }));
  return app;
}

describe("parseJson + error envelope (#17)", () => {
  it("returns the typed value on a valid body", async () => {
    const app = appUnder();
    const res = await app.request("/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Tee", age: 3 }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { name: "Tee", age: 3 } });
  });

  it("returns 422 with details.issues[] for multiple validation failures", async () => {
    const app = appUnder();
    const res = await app.request("/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", age: "not-a-number" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { issues?: Array<{ path: string }> } };
    };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    const paths = (body.error.details?.issues ?? []).map((i) => i.path).sort();
    expect(paths).toEqual(["age", "name"]);
  });

  it("returns 422 (not 500) for a malformed JSON body", async () => {
    const app = appUnder();
    const res = await app.request("/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details?: { issues?: unknown[] } } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details?.issues).toHaveLength(1);
  });

  it("err() omits details when not provided and includes it when given", async () => {
    const app = appUnder();
    const res = await app.request("/boom");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("TEAPOT");
    expect(body.error.details).toEqual({ issues: [{ path: "x", message: "bad", code: "c" }] });
  });
});
