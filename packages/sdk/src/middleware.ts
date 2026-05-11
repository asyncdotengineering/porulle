import type { Middleware } from "openapi-fetch";

export interface ApiKeyAuth {
  type: "api_key";
  key: string;
}

export interface BearerAuth {
  type: "bearer";
  token: string;
}

export type AuthCredential = ApiKeyAuth | BearerAuth;

/**
 * openapi-fetch middleware that injects authentication headers.
 *
 * Supports API key (x-api-key header) and Bearer token (Authorization header).
 */
export function authMiddleware(credential: AuthCredential): Middleware {
  return {
    onRequest({ request }) {
      if (credential.type === "api_key") {
        request.headers.set("x-api-key", credential.key);
      } else if (credential.type === "bearer") {
        request.headers.set("Authorization", `Bearer ${credential.token}`);
      }
      return request;
    },
  };
}
