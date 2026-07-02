import { describe, expect, it } from "vitest";
import { OfflineQueue, memoryStorage, webStorage, type QueuedOperation } from "../src/offline-queue.js";

// Issue #54 — POS apps must sell through network drops. The queue persists
// operations, stamps idempotency keys, replays on reconnect, and exposes
// observable state with manual retry/drop for failed operations.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake server that is offline until `goOnline()` and records received idempotency keys. */
function fakeServer() {
  let online = false;
  const received: Array<{ path: string; body: Record<string, unknown> }> = [];
  const seenKeys = new Set<string>();
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    if (!online) throw new TypeError("fetch failed: network down");
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const path = new URL(url, "http://localhost").pathname;
    received.push({ path, body });
    const key = body.idempotencyKey as string;
    const replay = seenKeys.has(key);
    seenKeys.add(key);
    // Replays return the original order, exactly like core's idempotencyKey contract.
    return jsonResponse(replay ? 200 : 201, { data: { id: `order-for-${key}`, replay } });
  };
  return {
    fetch: fetchImpl,
    received,
    goOnline: () => {
      online = true;
    },
    goOffline: () => {
      online = false;
    },
  };
}

describe("Issue #54 — SDK offline sale queue", () => {
  it("a sale submitted offline lands exactly once when connectivity returns", async () => {
    const server = fakeServer();
    const queue = new OfflineQueue({
      baseUrl: "http://localhost",
      fetch: server.fetch,
      autoFlush: false,
    });

    const op = await queue.enqueue("/api/checkout", { cartId: "cart-1", amount: 2200 });
    expect(op.body.idempotencyKey).toBe(op.id);

    // Offline: the immediate flush attempt fails, the op stays pending.
    await queue.flush();
    let state = await queue.state();
    expect(state.pending).toBe(1);
    expect(state.operations[0]!.lastError?.message).toContain("network");

    // Reconnect → drain. Exactly one delivery.
    server.goOnline();
    await queue.flush();
    state = await queue.state();
    expect(state.pending).toBe(0);
    expect(state.failed).toBe(0);
    expect(server.received).toHaveLength(1);
    expect(server.received[0]!.body.idempotencyKey).toBe(op.id);

    queue.dispose();
  });

  it("drains FIFO and preserves one idempotency key per operation across retries", async () => {
    const server = fakeServer();
    const queue = new OfflineQueue({ baseUrl: "http://localhost", fetch: server.fetch, autoFlush: false });

    const first = await queue.enqueue("/api/orders", { n: 1 });
    const second = await queue.enqueue("/api/orders", { n: 2 });
    await queue.flush(); // offline — both remain
    await queue.flush(); // still offline
    server.goOnline();
    await queue.flush();

    expect(server.received.map((r) => r.body.idempotencyKey)).toEqual([first.id, second.id]);
    expect((await queue.state()).pending).toBe(0);
    queue.dispose();
  });

  it("marks non-retryable HTTP failures as failed with the server error body, supports retry/drop", async () => {
    let status = 422;
    const fetchImpl: typeof globalThis.fetch = async () =>
      jsonResponse(status, { error: { code: "VALIDATION_FAILED", message: "bad cart" } });
    const queue = new OfflineQueue({ baseUrl: "http://localhost", fetch: fetchImpl, autoFlush: false });

    const op = await queue.enqueue("/api/checkout", { cartId: "nope" });
    await queue.flush();

    let state = await queue.state();
    expect(state.failed).toBe(1);
    expect(state.pending).toBe(0);
    const failed = state.operations.find((o: QueuedOperation) => o.id === op.id)!;
    expect(failed.lastError?.status).toBe(422);
    expect((failed.lastError?.body as any).error.code).toBe("VALIDATION_FAILED");

    // Manual retry after the server-side problem is fixed
    status = 201;
    await queue.retry(op.id);
    await queue.flush();
    state = await queue.state();
    expect(state.failed).toBe(0);
    expect(state.pending).toBe(0);

    // Drop removes an operation entirely
    const op2 = await queue.enqueue("/api/checkout", { cartId: "x" });
    await queue.drop(op2.id);
    expect((await queue.state()).operations).toHaveLength(0);
    queue.dispose();
  });

  it("retries 5xx up to maxAttempts then fails", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(500, { error: { code: "INTERNAL" } });
    };
    const queue = new OfflineQueue({
      baseUrl: "http://localhost",
      fetch: fetchImpl,
      autoFlush: false,
      maxAttempts: 3,
      backoffMs: 1,
    });
    const op = await queue.enqueue("/api/orders", {});
    // The backoff timer may interleave with manual flushes; loop until the
    // attempts cap resolves the op. The cap guarantees calls never exceeds 3.
    let guard = 0;
    while ((await queue.state()).failed === 0 && guard++ < 20) {
      await queue.flush();
    }
    const state = await queue.state();
    expect(calls).toBe(3);
    expect(state.failed).toBe(1);
    expect(state.operations[0]!.id).toBe(op.id);
    queue.dispose();
  });

  it("persists operations across queue instances (restart survival)", async () => {
    const backing = new Map<string, string>();
    const storageLike = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
    };

    const offlineFetch: typeof globalThis.fetch = async () => {
      throw new TypeError("network down");
    };
    const q1 = new OfflineQueue({
      baseUrl: "http://localhost",
      fetch: offlineFetch,
      storage: webStorage(storageLike),
      autoFlush: false,
    });
    const op = await q1.enqueue("/api/checkout", { cartId: "c" });
    q1.dispose();

    // "App restart": new instance, same storage — same op, same key.
    const server = fakeServer();
    server.goOnline();
    const q2 = new OfflineQueue({
      baseUrl: "http://localhost",
      fetch: server.fetch,
      storage: webStorage(storageLike),
      autoFlush: false,
    });
    await q2.flush();
    expect(server.received).toHaveLength(1);
    expect(server.received[0]!.body.idempotencyKey).toBe(op.id);
    expect((await q2.state()).pending).toBe(0);
    q2.dispose();
  });

  it("notifies subscribers on state changes", async () => {
    const states: number[] = [];
    const queue = new OfflineQueue({
      baseUrl: "http://localhost",
      fetch: async () => jsonResponse(201, { ok: true }),
      storage: memoryStorage(),
      autoFlush: false,
    });
    queue.onChange((s) => states.push(s.pending));
    await queue.enqueue("/api/orders", {});
    await queue.flush();
    expect(states[0]).toBe(1); // enqueued
    expect(states[states.length - 1]).toBe(0); // drained
    queue.dispose();
  });
});
