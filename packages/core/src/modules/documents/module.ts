import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import { DocumentsRepository } from "./repository/index.js";
import { invoiceSequences, orderDocuments } from "./schema.js";
import { DocumentsService } from "./service.js";

export const documentsModule = defineModule<
  { invoiceSequences: typeof invoiceSequences; orderDocuments: typeof orderDocuments },
  DocumentsService,
  Record<string, never>
>({
  id: "documents",
  schema: () => ({ invoiceSequences, orderDocuments }),
  service: (deps) =>
    new DocumentsService({
      repository: new DocumentsRepository(deps.db.db as DrizzleDatabase),
      services: deps.services as Record<string, unknown>,
    }),
});
