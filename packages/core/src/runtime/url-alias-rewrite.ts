import type { CommerceConfig } from "../config/types.js";

export function rewriteCommerceAliasRequest(
  request: Request,
  entities: CommerceConfig["entities"] | undefined,
): Request {
  const url = new URL(request.url);
  const path = url.pathname;

  for (const [entityType, entityConfig] of Object.entries(entities ?? {})) {
    if (!entityConfig.alias) continue;
    const alias = entityConfig.alias;
    const prefix = `/api/${alias}`;
    if (path === prefix) {
      url.pathname = "/api/catalog/entities";
      if (request.method === "GET") {
        url.searchParams.set("type", entityType);
      }
      return new Request(url.toString(), request);
    }
    if (path.startsWith(`${prefix}/`)) {
      url.pathname = path.replace(prefix, "/api/catalog/entities");
      return new Request(url.toString(), request);
    }
  }

  for (const [shortcut, target] of [["categories", "catalog/categories"], ["brands", "catalog/brands"]] as const) {
    const prefix = `/api/${shortcut}`;
    if (path === prefix) {
      url.pathname = `/api/${target}`;
      return new Request(url.toString(), request);
    }
    if (path.startsWith(`${prefix}/`)) {
      url.pathname = path.replace(prefix, `/api/${target}`);
      return new Request(url.toString(), request);
    }
  }

  return request;
}
