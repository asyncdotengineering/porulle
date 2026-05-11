import { describe, expect, it } from "vitest";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

describe("server", () => {
  it("starts and serves /api/health with DB probe", async () => {
    const { app } = await createServer(await createTestConfig());
    const response = await app.request("http://localhost/api/health");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
  });
});
