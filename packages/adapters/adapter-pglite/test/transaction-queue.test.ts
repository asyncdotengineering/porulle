import { describe, expect, it, vi } from "vitest";

const { statements } = vi.hoisted(() => ({ statements: [] as string[] }));

vi.mock("@electric-sql/pglite", () => ({
  PGlite: class {
    async exec(statement: string): Promise<void> {
      statements.push(statement);
    }
  },
}));

vi.mock("drizzle-orm/pglite", () => ({
  drizzle: vi.fn((pg: { exec(statement: string): Promise<void> }) => ({
    execute: (statement: string) => pg.exec(statement),
  })),
}));

import { pgliteAdapter } from "../src/index.js";

describe("pgliteAdapter transaction queue", () => {
  it("does not interleave concurrent transaction bodies", async () => {
    statements.length = 0;
    const adapter = await pgliteAdapter({ migrate: false, seedDefaultOrg: false });
    const db = adapter.db as { execute(statement: string): Promise<void> };

    const first = adapter.transaction(async () => {
      await db.execute("BODY 1");
    });
    const second = adapter.transaction(async () => {
      await db.execute("BODY 2");
    });

    await Promise.all([first, second]);

    expect(statements).toEqual(["BEGIN", "BODY 1", "COMMIT", "BEGIN", "BODY 2", "COMMIT"]);
  });
});
