import type { HookContext } from "../../kernel/hooks/types.js";
import type { SearchService } from "./service.js";

export async function syncToSearchIndex(args: {
  result: { id: string };
  context: HookContext;
}): Promise<void> {
  const service = args.context.services.search as SearchService | undefined;
  if (!service) return;

  await service.syncEntity(args.result.id);
}
