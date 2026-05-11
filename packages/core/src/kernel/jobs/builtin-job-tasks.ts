import { webhookDeliveryTask } from "../../modules/webhooks/tasks.js";
import { staleJobReaperTask } from "./reaper.js";
import type { TaskDefinition } from "./types.js";

export const defaultKernelJobTasks: TaskDefinition<
  Record<string, unknown>,
  Record<string, unknown>
>[] = [
  webhookDeliveryTask as TaskDefinition<
    Record<string, unknown>,
    Record<string, unknown>
  >,
  staleJobReaperTask as TaskDefinition<
    Record<string, unknown>,
    Record<string, unknown>
  >,
];
