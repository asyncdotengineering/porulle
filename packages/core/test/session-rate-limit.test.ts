import { describe, expect, it } from "vitest";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

type ServerApp = Awaited<ReturnType<typeof createServer>>["app"];

const testIpResolver = (c: {
  req: { header(name: string): string | undefined };
}) => c.req.header("x-test-ip") ?? "test-client";

function sessionRequest(app: ServerApp, ip = "test-client") {
  return app.request("http://localhost/api/auth/get-session", {
    headers: { "x-test-ip": ip },
  });
}

function signInRequest(app: ServerApp, ip = "test-client") {
  return app.request("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "x-test-ip": ip,
    },
    body: JSON.stringify({
      email: "rate-limit@test.local",
      password: "invalid",
    }),
  });
}

describe("session rate-limit bucket", () => {
  it("allows 120 session reads and refuses the 121st by default", async () => {
    const { app } = await createServer(
      await createTestConfig({
        runtime: { getClientIp: testIpResolver },
        rateLimits: { api: 1000, auth: 1000, signInPerEmail: 1000 },
      }),
    );

    for (let requestNumber = 1; requestNumber <= 120; requestNumber++) {
      const response = await sessionRequest(app);
      expect(response.status, `get-session request ${requestNumber}`).not.toBe(
        429,
      );
    }

    const blocked = await sessionRequest(app);
    expect(blocked.status).toBe(429);
  });

  it("uses the configured session limit", async () => {
    const { app } = await createServer(
      await createTestConfig({
        runtime: { getClientIp: testIpResolver },
        rateLimits: { api: 100, auth: 100, session: 2, signInPerEmail: 100 },
      }),
    );

    expect((await sessionRequest(app)).status).not.toBe(429);
    expect((await sessionRequest(app)).status).not.toBe(429);
    expect((await sessionRequest(app)).status).toBe(429);
  });

  it("keeps session and credential budgets independent", async () => {
    const createIndependentConfig = () =>
      createTestConfig({
        runtime: { getClientIp: testIpResolver },
        rateLimits: { api: 100, auth: 1, session: 1, signInPerEmail: 100 },
      });

    const sessionFirst = await createServer(await createIndependentConfig());
    expect((await sessionRequest(sessionFirst.app)).status).not.toBe(429);
    expect((await sessionRequest(sessionFirst.app)).status).toBe(429);
    expect((await signInRequest(sessionFirst.app)).status).not.toBe(429);

    const authFirst = await createServer(await createIndependentConfig());
    expect((await signInRequest(authFirst.app)).status).not.toBe(429);
    expect((await signInRequest(authFirst.app)).status).toBe(429);
    expect((await sessionRequest(authFirst.app)).status).not.toBe(429);
  });
});
