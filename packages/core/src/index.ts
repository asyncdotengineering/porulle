export { defineConfig } from "./config/define-config.js";
export type {
  CommerceConfig,
  CommercePlugin,
  ApiKeyScopeDefinition,
} from "./config/types.js";
export { defineCommercePlugin } from "./kernel/plugin/manifest.js";
export type {
  CommercePluginManifest,
  PluginContext,
  PluginHookRegistration,
  PluginLogger,
  PluginPermission,
  PluginRouteRegistration,
} from "./kernel/plugin/manifest.js";

export { router } from "./interfaces/rest/router.js";
export { webhookRouter, type WebhookRouterResult } from "./interfaces/rest/webhook-router.js";
export { isPrivateUrl, isPrivateIp } from "./modules/webhooks/ssrf-guard.js";
export { createServer } from "./runtime/server.js";
export { createLogger } from "./runtime/logger.js";
export type { Logger as PinoLogger } from "./runtime/logger.js";
export { setupGracefulShutdown } from "./runtime/shutdown.js";
export { createKernel } from "./runtime/kernel.js";
export type { Kernel } from "./runtime/kernel.js";
// Test utilities moved to @porulle/core/testing sub-path export.
// Import from "@porulle/core/testing" instead of "@porulle/core".
// This avoids pulling drizzle-kit/tsx/esbuild into Turbopack's bundle graph.

export type { Actor } from "./auth/types.js";
export { resolveOrgId, ensureDefaultOrg, DEFAULT_ORG_ID } from "./auth/org.js";
export { OrganizationService } from "./modules/organization/service.js";
export { createScopedDb } from "./kernel/database/scoped-db.js";
export type { ScopedOrganizationId } from "./kernel/database/scoped-db.js";
export { assertOwnership, assertPermission } from "./auth/permissions.js";
export type { AccessResult, AccessContext, AccessFn, WhereClause } from "./auth/access.js";
export {
  accessOR,
  accessAND,
  conditional,
  isAdmin,
  isAuthenticated,
  isDocumentOwner,
  publicAccess,
  denyAll,
} from "./auth/access.js";

export { HookRegistry } from "./kernel/hooks/registry.js";
export type {
  BeforeHook,
  AfterHook,
  HookContext,
  HookOperation,
  HookOrigin,
  Logger,
  ServiceContainer,
} from "./kernel/hooks/types.js";
export { runBeforeHooks, runAfterHooks } from "./kernel/hooks/executor.js";
export { createHookContext } from "./kernel/hooks/create-context.js";
export type { CreateHookContextArgs } from "./kernel/hooks/create-context.js";
export type { JobsAdapter, EnqueueOptions } from "./kernel/jobs/adapter.js";
export { NullJobsAdapter } from "./kernel/jobs/adapter.js";
export { DrizzleJobsAdapter } from "./kernel/jobs/drizzle-adapter.js";
export { runPendingJobs } from "./kernel/jobs/runner.js";
export type { RunPendingJobsArgs } from "./kernel/jobs/runner.js";
export type {
  TaskDefinition,
  TaskContext,
  TaskJobMeta,
  TaskRetryConfig,
} from "./kernel/jobs/types.js";
export { BUILTIN_JOB_TASK_SLUGS } from "./kernel/jobs/types.js";
export {
  staleJobReaperTask,
  runStaleJobReaper,
  getJobReapThresholdMs,
  getJobsReaperIntervalMs,
} from "./kernel/jobs/reaper.js";

export { createLocalAPI, LocalAPI } from "./kernel/local-api.js";
export type { CommerceLocalAPI, LocalAPIOptions } from "./kernel/local-api.js";
export { createCommerce } from "./runtime/commerce.js";
export type { CommerceInstance } from "./runtime/commerce.js";

export { createAuditService, createNullAuditService } from "./modules/audit/service.js";
export type {
  AuditService,
  AuditEntry,
  RecordArgs,
  ListForEntityArgs,
} from "./modules/audit/service.js";

export type { Result, PluginResult, PluginResultErr } from "./kernel/result.js";
export { Ok, Err, PluginErr } from "./kernel/result.js";
export type { PluginDb, PluginTxFn } from "./kernel/database/plugin-types.js";
export type { ServiceRegistry } from "./kernel/service-registry.js";
export { defineModule } from "./kernel/module/index.js";
export type { AppModule, ModuleDeps, ServiceMap } from "./kernel/module/index.js";
export { toHttpError, type HttpErrorResponse } from "./kernel/http-error.js";
export { withTiming } from "./kernel/service-timing.js";

export {
  CommerceNotFoundError,
  CommerceValidationError,
  CommerceForbiddenError,
  CommerceConflictError,
  CommerceInvalidTransitionError,
  OrgResolutionError,
} from "./kernel/errors.js";

export { mapErrorToStatus } from "./kernel/error-mapper.js";

export {
  canTransition,
  assertTransition,
  orderStateMachine,
  extendOrderStateMachine,
} from "./kernel/state-machine/machine.js";

export type {
  PaymentAdapter,
  PaymentCapture,
  PaymentIntent,
  PaymentRefund,
  PaymentWebhookEvent,
} from "./modules/payments/adapter.js";
export type { StorageAdapter } from "./modules/media/adapter.js";
export type {
  SearchAdapter,
  SearchDocument,
  SearchFilters,
  SearchHit,
  SearchQueryParams,
  SearchQueryResult,
  SearchSuggestParams,
} from "./modules/search/adapter.js";
export type { DatabaseAdapter } from "./kernel/database/adapter.js";
export {
  createTxContext,
  reuseOrCreateTxContext,
  withTransaction,
} from "./kernel/database/tx-context.js";
export type {
  TxContext,
  WithTransactionOptions,
} from "./kernel/database/tx-context.js";
export type {
  TaxAdapter,
  TaxAddress,
  TaxCalculationParams,
  TaxCalculationResult,
  TaxLineItem,
  TaxReportParams,
  TaxVoidParams,
} from "./modules/tax/adapter.js";

export {
  getSchema,
  buildSchema,
  getTableNames,
  getSchemaFiles,
  pushSchema,
} from "./kernel/database/migrate.js";
export { consoleEmailAdapter } from "./adapters/console-email.js";

export { promotionTypeEnum, type PromotionType } from "./modules/promotions/schemas.js";

export { parseJson, err } from "./interfaces/rest/parse-json.js";
export type { ValidationIssue, ErrorDetails } from "./interfaces/rest/parse-json.js";

export { runCompensationChain } from "./kernel/compensation/executor.js";
export type {
  CompensationContext,
  Step,
} from "./kernel/compensation/types.js";

export { createRepository } from "./kernel/factory/repository-factory.js";
export type {
  BaseRepository,
  SoftDeletableRepository,
  RepositoryFor,
  Filters,
  FindOptions,
} from "./kernel/factory/repository-factory.js";

export type { CartItemMatcher } from "./modules/cart/matcher.js";
export { defaultCartItemMatcher } from "./modules/cart/matcher.js";
export { canAccessCart } from "./modules/cart/access.js";

export { QueryRegistry } from "./kernel/query/registry.js";
export { executeQuery } from "./kernel/query/executor.js";
export type {
  RelationDefinition,
  EntityDefinition,
} from "./kernel/query/registry.js";
export type { QueryInput, QueryResult } from "./kernel/query/executor.js";

export type { CommerceModuleTypes } from "./types/commerce-types.js";

export { staleOrderCleanupTask } from "./modules/orders/stale-order-cleanup.js";
export { COMMERCE_AGENT_SYSTEM_PROMPT } from "./utils/agent-prompt.js";

export { DrizzleAnalyticsAdapter } from "./modules/analytics/drizzle-adapter.js";
export { BUILTIN_ANALYTICS_MODELS } from "./modules/analytics/models.js";
export { buildAnalyticsScope } from "./modules/analytics/types.js";
export type {
  AnalyticsAdapter,
  AnalyticsQueryParams,
  AnalyticsQueryResult,
  AnalyticsMeta,
  AnalyticsModelDefinition,
  AnalyticsScope,
  AnalyticsModel,
  AnalyticsScopeRule,
  AnalyticsMeasure,
  AnalyticsDimension,
  AnalyticsJoin,
  // Deprecated aliases (remove in next major)
  CubeScopeRule,
  CubeDefinition,
  MeasureDefinition,
  DimensionDefinition,
  JoinDefinition,
} from "./modules/analytics/types.js";
