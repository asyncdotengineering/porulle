import type { CommerceConfig } from "../config/types.js";
import { createKernel } from "../runtime/kernel.js";
import { createTestConfig } from "./create-test-config.js";

export async function createTestKernel(overrides: Partial<CommerceConfig> = {}) {
  return createKernel(await createTestConfig(overrides));
}
