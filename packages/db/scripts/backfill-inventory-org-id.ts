import { DEFAULT_ORG_ID } from "@porulle/core";
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (url == null || url === "") {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  const danglingLevels = rowsFromExecute(
    await db.execute(sql`
      SELECT il.id AS row_id, il.warehouse_id AS warehouse_id
      FROM inventory_levels il
      LEFT JOIN warehouses w ON w.id = il.warehouse_id
      WHERE w.id IS NULL
    `),
  );
  for (const row of danglingLevels) {
    console.warn(
      `[backfill-inventory-org-id] inventory_levels id=${String(row.row_id)} references missing warehouse_id=${String(row.warehouse_id)}; will assign ${DEFAULT_ORG_ID}`,
    );
  }

  const danglingMovements = rowsFromExecute(
    await db.execute(sql`
      SELECT im.id AS row_id, im.warehouse_id AS warehouse_id
      FROM inventory_movements im
      LEFT JOIN warehouses w ON w.id = im.warehouse_id
      WHERE w.id IS NULL
    `),
  );
  for (const row of danglingMovements) {
    console.warn(
      `[backfill-inventory-org-id] inventory_movements id=${String(row.row_id)} references missing warehouse_id=${String(row.warehouse_id)}; will assign ${DEFAULT_ORG_ID}`,
    );
  }

  const levelsUpdated = rowsFromExecute(
    await db.execute(sql`
      UPDATE inventory_levels il
      SET organization_id = COALESCE(
        (SELECT w.organization_id FROM warehouses w WHERE w.id = il.warehouse_id),
        ${DEFAULT_ORG_ID}
      )
      WHERE il.organization_id IS DISTINCT FROM COALESCE(
        (SELECT w.organization_id FROM warehouses w WHERE w.id = il.warehouse_id),
        ${DEFAULT_ORG_ID}
      )
      RETURNING il.id
    `),
  );

  const movementsUpdated = rowsFromExecute(
    await db.execute(sql`
      UPDATE inventory_movements im
      SET organization_id = COALESCE(
        (SELECT w.organization_id FROM warehouses w WHERE w.id = im.warehouse_id),
        ${DEFAULT_ORG_ID}
      )
      WHERE im.organization_id IS DISTINCT FROM COALESCE(
        (SELECT w.organization_id FROM warehouses w WHERE w.id = im.warehouse_id),
        ${DEFAULT_ORG_ID}
      )
      RETURNING im.id
    `),
  );

  console.log(
    `[backfill-inventory-org-id] inventory_levels rows updated: ${levelsUpdated.length}; inventory_movements rows updated: ${movementsUpdated.length}`,
  );

  await client.end({ timeout: 5 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
