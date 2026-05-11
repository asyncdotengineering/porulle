import type { CommerceConfig } from "../../config/types.js";
import type { DrizzleDatabase } from "../../kernel/database/drizzle-db.js";
import { defineModule } from "../../kernel/module/index.js";
import { CatalogRepository } from "../catalog/repository/index.js";
import { MediaRepository } from "./repository/index.js";
import { MediaService } from "./service.js";
import { entityMedia, mediaAssets } from "./schema.js";

export const mediaModule = defineModule({
  id: "media",
  schema: () => ({ mediaAssets, entityMedia }),
  service: (deps) => {
    const db = deps.db.db as DrizzleDatabase;
    const storage = (deps.config as CommerceConfig).storage;
    if (storage == null) {
      throw new Error("Media module requires config.storage");
    }
    return new MediaService({
      repository: new MediaRepository(db),
      catalogRepository: new CatalogRepository(db),
      storage,
      config: deps.config as CommerceConfig,
    });
  },
});
