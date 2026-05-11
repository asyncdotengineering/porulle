import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import { CustomersRepository } from "./repository/index.js";
import { CustomerService } from "./service.js";
import {
  customerAddresses,
  customerGroupMembers,
  customerGroups,
  customers,
} from "./schema.js";

export const customersModule = defineModule({
  id: "customers",
  schema: () => ({
    customers,
    customerAddresses,
    customerGroups,
    customerGroupMembers,
  }),
  service: (deps) =>
    new CustomerService({
      repository: new CustomersRepository(deps.db.db as DrizzleDatabase),
      hooks: deps.hooks,
      services: deps.services,
      database: deps.db,
    }),
});
