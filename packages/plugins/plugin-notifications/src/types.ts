import type { notificationTemplates, customerNotificationPrefs, notificationLog, printJobs } from "./schema.js";

export type { PluginDb as Db } from "@porulle/core";
export type NotificationTemplate = typeof notificationTemplates.$inferSelect;
export type CustomerNotificationPref = typeof customerNotificationPrefs.$inferSelect;
export type NotificationLogEntry = typeof notificationLog.$inferSelect;
export type PrintJob = typeof printJobs.$inferSelect;
export type Channel = "email" | "sms" | "push" | "print";
export type PrefChannel = "email" | "sms" | "push";
export type NotificationStatus = "queued" | "sent" | "delivered" | "failed";
export type PrintJobStatus = "queued" | "printing" | "printed" | "failed";
export type PrintJobType = "receipt" | "label" | "sticker" | "kot";

/** Result type re-exports from core. */
export { Ok, Err } from "@porulle/core";
export type { PluginResult as Result, PluginResultErr as ResultErr } from "@porulle/core";
