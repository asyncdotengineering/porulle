import { defaultConfig } from "./defaults.js";
import type { CommerceConfig, DefineConfigInput } from "./types.js";
import type { TaskDefinition } from "../kernel/jobs/types.js";
import { defaultKernelJobTasks } from "../kernel/jobs/builtin-job-tasks.js";
import { _resetRegisteredPlugins } from "../kernel/plugin/manifest.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeBuiltinJobTasks(
  jobs: CommerceConfig["jobs"] | undefined,
): NonNullable<CommerceConfig["jobs"]> {
  const userTasks = jobs?.tasks ?? [];
  const bySlug = new Map<string, TaskDefinition>();
  for (const t of defaultKernelJobTasks) {
    bySlug.set(t.slug, t);
  }
  for (const t of userTasks) {
    bySlug.set(t.slug, t);
  }
  return {
    ...(jobs ?? {}),
    tasks: Array.from(bySlug.values()) as TaskDefinition<
      Record<string, unknown>,
      Record<string, unknown>
    >[],
  };
}

function merge<T extends object>(base: T, next: Partial<T>): T {
  const output: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
    if (value === undefined) continue;
    const baseValue = output[key];
    if (
      isRecord(value) &&
      isRecord(baseValue)
    ) {
      output[key] = merge(baseValue, value);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

/**
 * Builds the final CommerceConfig by:
 * 1. Merging user input with defaults
 * 2. Applying all plugins (each is a config transform function)
 * 3. Merging built-in job task definitions (user tasks override by slug)
 * 4. Freezing the result to prevent runtime mutation
 */
export async function defineConfig(
  input: DefineConfigInput,
): Promise<CommerceConfig> {
  let config = merge(defaultConfig as CommerceConfig, input);

  // Merge top-level `schema` into `customSchemas` before plugins run
  if (config.schema?.length) {
    config = {
      ...config,
      customSchemas: [...(config.customSchemas ?? []), ...config.schema],
    };
  }

  _resetRegisteredPlugins();
  for (const plugin of config.plugins ?? []) {
    config = await plugin(config);
  }

  config = {
    ...config,
    jobs: mergeBuiltinJobTasks(config.jobs),
  };

  return Object.freeze(config);
}
