import { defineCommercePlugin } from "@porulle/core";
import { notificationTemplates, customerNotificationPrefs, notificationLog, printJobs } from "./schema.js";
import { NotificationService } from "./services/notification-service.js";
import { PreferenceService } from "./services/preference-service.js";
import { PrintService } from "./services/print-service.js";
import { buildNotificationRoutes } from "./routes/notifications.js";
import type { NotificationAdapters } from "./adapters/types.js";

// Re-exports for consumers
export type { Db } from "./types.js";
export type { NotificationTemplate, CustomerNotificationPref, NotificationLogEntry, PrintJob, Result, ResultErr, Channel, PrefChannel, NotificationStatus, PrintJobStatus, PrintJobType } from "./types.js";
export type { SMSAdapter, PushAdapter, PrintAdapter, NotificationAdapters } from "./adapters/types.js";
export { NotificationService } from "./services/notification-service.js";
export { PreferenceService } from "./services/preference-service.js";
export { PrintService } from "./services/print-service.js";
export { consoleSMSAdapter, consolePushAdapter, consolePrintAdapter } from "./adapters/console.js";

/**
 * Notifications Plugin
 *
 * Provides:
 * - Notification template CRUD with Handlebars-style rendering
 * - Multi-channel dispatch (email, SMS, push, print)
 * - Customer notification preferences (opt-out model)
 * - Notification log with status tracking
 * - Print job management (receipt, label, sticker, KOT)
 * - Pluggable adapter architecture for SMS, Push, and Print providers
 *
 * @param adapters - Optional adapter configuration. Pass console adapters for dev,
 *   or real adapters (Twilio, FCM, ESC/POS) for production.
 */
export function notificationsPlugin(adapters?: NotificationAdapters) {
  return defineCommercePlugin({
    id: "notifications",
    version: "1.0.0",
    permissions: [
      { scope: "notifications:admin", description: "Manage notification templates, send notifications, view log, manage print jobs." },
      { scope: "notifications:write", description: "Set customer notification preferences." },
      { scope: "notifications:read", description: "View customer notification preferences." },
    ],
    schema: () => ({ notificationTemplates, customerNotificationPrefs, notificationLog, printJobs }),
    hooks: () => [],
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      const notifService = new NotificationService(db, adapters);
      const prefService = new PreferenceService(db);
      const printService = new PrintService(db, adapters?.print);
      return buildNotificationRoutes(notifService, prefService, printService, ctx);
    },
  });
}
