export { createSDK, createClient, type SDKOptions } from "./client.js";
export { authMiddleware, type AuthCredential, type ApiKeyAuth, type BearerAuth } from "./middleware.js";
export {
  isApiError,
  mapApiErrorToFields,
  type ApiErrorBody,
  type ValidationIssue,
} from "./errors.js";
