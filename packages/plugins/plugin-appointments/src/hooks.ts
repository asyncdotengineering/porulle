import type { PluginHookRegistration } from "@porulle/core";
import type { AppointmentPluginOptions } from "./types.js";

/**
 * Appointment plugin hooks.
 *
 * Notification job enqueueing (reminders, cancellation notices, etc.) is handled
 * directly by BookingService, not via hooks. The BookingService receives a
 * JobsAdapter from the kernel's service container and enqueues jobs inline
 * after successful operations. This avoids the dead-code problem where plugin
 * hooks register handlers for custom keys that nobody fires.
 */
export function buildHooks(_options: AppointmentPluginOptions): PluginHookRegistration[] {
  return [];
}
