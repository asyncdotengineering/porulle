import { defineModule } from "../../kernel/module/index.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { auditLog } from "./schema.js";
import { createAuditService } from "./service.js";

export const auditModule = defineModule({
  id: "audit",
  schema: () => ({ auditLog }),
  service: (deps) =>
    createAuditService(deps.db.db as DrizzleDatabase),
});
