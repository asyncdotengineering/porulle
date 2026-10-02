import { describe, expect, it } from "vitest";
import {
  createPGliteTransaction,
  currencyExponent,
  normalizeExecuteShape,
  OrgResolutionError,
  renderEmail,
  toMinorUnits,
} from "../src/index.js";
import { prepareEnqueue, type TaskDefinition } from "../src/jobs.js";
import { createTestActor, TEST_ORG_ID } from "../src/testing.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";

describe("toMinorUnits", () => {
  it("scales a two-decimal currency by 100", () => {
    expect(toMinorUnits("15.00", "USD")).toBe(1500);
    expect(toMinorUnits("19.99", "USD")).toBe(1999);
    expect(toMinorUnits(12.5, "EUR")).toBe(1250);
  });

  it("does not scale a zero-decimal currency", () => {
    expect(toMinorUnits("1500", "JPY")).toBe(1500);
    expect(toMinorUnits("1500", "jpy")).toBe(1500);
    expect(currencyExponent("KRW")).toBe(0);
    expect(currencyExponent("USD")).toBe(2);
  });

  it("answers undefined for a blank or non-numeric amount", () => {
    expect(toMinorUnits("", "USD")).toBeUndefined();
    expect(toMinorUnits("  ", "USD")).toBeUndefined();
    expect(toMinorUnits("abc", "USD")).toBeUndefined();
    expect(toMinorUnits(null, "USD")).toBeUndefined();
    expect(toMinorUnits(undefined, "USD")).toBeUndefined();
  });
});

describe("renderEmail", () => {
  it("escapes caller data interpolated into the default templates", () => {
    const { html } = renderEmail("password-reset", { url: '"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });

  it("escapes the fallback body for a template it does not know", () => {
    const { subject, html } = renderEmail("custom-notice", { note: "<b>hi</b>" });
    expect(subject).toBe("custom-notice");
    expect(html).not.toContain("<b>hi</b>");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("lets caller-supplied subjects and templates win over the defaults", () => {
    const rendered = renderEmail("order-confirmation", { orderId: "abc" }, {
      subjects: { "order-confirmation": () => "Thanks" },
      templates: { "order-confirmation": () => "<p>custom</p>" },
    });
    expect(rendered).toEqual({ subject: "Thanks", html: "<p>custom</p>" });
  });
});

describe("prepareEnqueue", () => {
  const task: TaskDefinition = {
    slug: "sync",
    handler: async () => ({ output: {} }),
    retries: { attempts: 4 },
    concurrency: { key: (input) => `k:${String(input.id)}`, supersedes: true },
  };
  const tasks = new Map([[task.slug, task]]);

  it("rejects a slug no task was registered for", () => {
    expect(() => prepareEnqueue(tasks, "missing", {}, { organizationId: "org_a" })).toThrow(/Unknown task slug: missing/);
  });

  it("rejects a blank organization as an org-resolution failure", () => {
    expect(() => prepareEnqueue(tasks, "sync", {}, { organizationId: "  " })).toThrow(OrgResolutionError);
  });

  it("derives defaults from the task and lets enqueue options override them", () => {
    expect(prepareEnqueue(tasks, "sync", { id: 7 }, { organizationId: " org_a " })).toMatchObject({
      task,
      organizationId: "org_a",
      concurrencyKey: "k:7",
      exclusive: true,
      supersedes: true,
      maxAttempts: 4,
    });
    expect(
      prepareEnqueue(tasks, "sync", { id: 7 }, {
        organizationId: "org_a",
        concurrencyKey: "custom",
        supersedes: false,
        maxAttempts: 1,
      }),
    ).toMatchObject({ concurrencyKey: "custom", supersedes: false, maxAttempts: 1 });
  });

  it("is what the built-in drizzle engine applies: an unknown slug is refused at enqueue", async () => {
    const engine = new DrizzleJobsAdapter({} as never);
    await expect(engine.enqueue("missing", {}, { organizationId: "org_a" })).rejects.toThrow(/Unknown task slug: missing/);
  });
});

describe("createPGliteTransaction", () => {
  function recordingPg() {
    const statements: string[] = [];
    return {
      statements,
      pg: { exec: async (statement: string) => { statements.push(statement); } },
    };
  }

  it("queues concurrent bodies instead of interleaving them inside one BEGIN", async () => {
    const { pg, statements } = recordingPg();
    const { transaction } = createPGliteTransaction(pg, "db");
    await Promise.all([
      transaction(async () => { statements.push("a"); await new Promise((r) => setTimeout(r, 5)); statements.push("a2"); }),
      transaction(async () => { statements.push("b"); }),
    ]);
    expect(statements).toEqual(["BEGIN", "a", "a2", "COMMIT", "BEGIN", "b", "COMMIT"]);
  });

  it("queues a transaction that starts while another body is already running", async () => {
    const { pg, statements } = recordingPg();
    const { transaction } = createPGliteTransaction(pg, "db");
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => { releaseA = r; });
    const a = transaction(async () => { statements.push("a"); await gate; statements.push("a2"); });
    await new Promise((r) => setTimeout(r, 0));
    expect(statements).toEqual(["BEGIN", "a"]);
    const b = transaction(async () => { statements.push("b"); });
    await new Promise((r) => setTimeout(r, 0));
    releaseA();
    await Promise.all([a, b]);
    expect(statements).toEqual(["BEGIN", "a", "a2", "COMMIT", "BEGIN", "b", "COMMIT"]);
  });

  it("does not run later bodies outside a transaction after a BEGIN fails", async () => {
    const statements: string[] = [];
    let failNextBegin = true;
    const pg = {
      exec: async (statement: string) => {
        if (statement === "BEGIN" && failNextBegin) { failNextBegin = false; throw new Error("begin failed"); }
        statements.push(statement);
      },
    };
    const { transaction, inTransaction } = createPGliteTransaction(pg, "db");
    await expect(transaction(async () => { statements.push("first"); })).rejects.toThrow("begin failed");
    expect(inTransaction()).toBe(false);
    await transaction(async () => { statements.push("second"); });
    expect(statements).toEqual(["BEGIN", "second", "COMMIT"]);
  });

  it("joins an open transaction for a nested call and rolls back on failure", async () => {
    const { pg, statements } = recordingPg();
    const { transaction, inTransaction } = createPGliteTransaction(pg, "db");
    await expect(
      transaction(async (tx) => {
        expect(tx).toBe("db");
        expect(inTransaction()).toBe(true);
        await transaction(async () => { statements.push("nested"); });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(statements).toEqual(["BEGIN", "nested", "ROLLBACK"]);
    expect(inTransaction()).toBe(false);
  });
});

describe("normalizeExecuteShape", () => {
  it("returns the row array from a { rows } driver result", async () => {
    const db = normalizeExecuteShape({ execute: async () => ({ rows: [{ n: 1 }], rowCount: 1 }) });
    await expect(db.execute()).resolves.toEqual([{ n: 1 }]);
  });
});

describe("createTestActor", () => {
  it("builds a test-org actor and applies overrides", () => {
    const actor = createTestActor({ permissions: ["loyalty:admin"], role: "staff" });
    expect(actor.organizationId).toBe(TEST_ORG_ID);
    expect(actor.permissions).toEqual(["loyalty:admin"]);
    expect(actor.type).toBe("user");
  });
});
