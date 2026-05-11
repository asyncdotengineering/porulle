import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@porulle/core/schema";

function rowsFromExecute(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

function nextSeqValue(lastValue: unknown, isCalled: unknown): number {
  const last = Number(lastValue);
  const called = isCalled === true;
  return called ? last + 1 : last;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (url == null || url === "") {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  const maxRows = rowsFromExecute(
    await db.execute(sql`
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(order_number FROM '[0-9]+$') AS INTEGER)),
        0
      ) AS max_seq
      FROM orders
    `),
  );
  const max = Number(maxRows[0]?.max_seq ?? 0);
  const target = max + 1;

  const stateRows = rowsFromExecute(
    await db.execute(sql`SELECT last_value, is_called FROM order_number_seq`),
  );
  const state = stateRows[0];
  if (state == null) {
    console.error("order_number_seq not found — run drizzle-kit push first");
    process.exit(1);
  }

  const next = nextSeqValue(state.last_value, state.is_called);
  if (next >= target) {
    console.log(
      `order_number_seq unchanged (next would be ${next}, target ${target})`,
    );
    await client.end({ timeout: 5 });
    return;
  }

  await db.execute(sql`SELECT setval('order_number_seq', ${target}, false)`);
  console.log(`order_number_seq aligned: next nextval() returns ${target}`);
  await client.end({ timeout: 5 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
