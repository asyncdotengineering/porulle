/**
 * A route can declare what it returns.
 *
 * Without `.output()` every route documents its payload as `any`, so
 * openapi-typescript generates `data?: unknown` for the whole API and a
 * consumer has to hand-maintain a parallel schema. These tests pin the
 * generated OpenAPI response shape, in both directions.
 */

import { describe, it, expect } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { router } from "../src/index.js";
import type { PluginRouteRegistration } from "../src/kernel/plugin/manifest.js";

function openapiRoutes(routes: PluginRouteRegistration[]) {
  return routes.filter((route): route is Extract<PluginRouteRegistration, { openapi: unknown }> => "openapi" in route);
}

const VendorSchema = z.object({ id: z.string(), name: z.string() });

function documentFor(build: (r: ReturnType<typeof router>) => void) {
  const r = router("Vendors", "/vendors");
  build(r);
  const app = new OpenAPIHono();
  for (const route of openapiRoutes(r.routes())) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.openapi(route.openapi as any, route.handler as any);
  }
  return app.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "t", version: "1" } });
}

function successSchema(doc: ReturnType<typeof documentFor>, path: string, status: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responses = (doc.paths?.[path] as any)?.get?.responses;
  return responses?.[status]?.content?.["application/json"]?.schema;
}

describe("route response schema", () => {
  it("documents the declared shape inside the data envelope", () => {
    const doc = documentFor((r) => {
      r.get("/{id}").summary("Get").output(VendorSchema).handler(async () => ({ id: "v1", name: "Ferra" }));
    });
    const schema = successSchema(doc, "/api/vendors/{id}", "200");
    expect(schema?.properties?.data?.type).toBe("object");
    expect(Object.keys(schema?.properties?.data?.properties ?? {}).sort()).toEqual(["id", "name"]);
    expect(schema?.properties?.data?.required?.sort()).toEqual(["id", "name"]);
  });

  it("leaves a route without output() exactly as it was", () => {
    const doc = documentFor((r) => {
      r.get("/{id}").summary("Get").handler(async () => ({ id: "v1" }));
    });
    const schema = successSchema(doc, "/api/vendors/{id}", "200");
    expect(schema?.properties?.data?.properties).toBeUndefined();
  });

  it("does not validate the handler's return against the schema", async () => {
    const pluginCtx = { config: { auth: { defaultOrganizationId: "org-test" } }, services: {}, db: undefined };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = router("Vendors", "/vendors", pluginCtx as any);
    r.get("/{id}").summary("Get").output(VendorSchema).handler(async () => ({ unexpected: true }));
    const app = new OpenAPIHono();
    for (const route of openapiRoutes(r.routes())) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.openapi(route.openapi as any, route.handler as any);
    }
    const response = await app.request("/api/vendors/3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { unexpected: true } });
  });
});
