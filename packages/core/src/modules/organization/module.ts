import { member, organization } from "../../auth/auth-schema.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import { OrganizationService } from "./service.js";

export const organizationModule = defineModule({
  id: "organization",
  schema: () => ({ organization, member }),
  service: (deps) =>
    new OrganizationService(deps.db.db as DrizzleDatabase),
});
