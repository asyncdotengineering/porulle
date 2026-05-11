import type { CommerceConfig } from "../config/types.js";
import { createTestConfig } from "./create-test-config.js";
import { createKernel } from "../runtime/kernel.js";

export interface RepositoryTestHarness {
  config: CommerceConfig;
  kernel: ReturnType<typeof createKernel>;
}

export async function createRepositoryTestHarness(
  overrides: Partial<CommerceConfig> = {},
): Promise<RepositoryTestHarness> {
  const config = await createTestConfig(overrides);
  const kernel = createKernel(config);
  return { config, kernel };
}
