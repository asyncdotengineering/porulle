import type { Result } from "../types.js";

/**
 * SMS Adapter interface.
 *
 * Implement this interface to integrate with an SMS provider (e.g. Twilio, Vonage).
 * The `send` method delivers a text message to the given phone number.
 */
export interface SMSAdapter {
  /** Unique provider identifier (e.g. "twilio", "vonage", "console"). */
  providerId: string;
  /** Send an SMS message to the given phone number. */
  send(params: { to: string; body: string }): Promise<Result<{ messageId: string }>>;
}

/**
 * Push Notification Adapter interface.
 *
 * Implement this interface to integrate with a push notification service
 * (e.g. Firebase Cloud Messaging, Apple Push Notification Service).
 */
export interface PushAdapter {
  /** Unique provider identifier (e.g. "fcm", "apns", "console"). */
  providerId: string;
  /** Send a push notification to the given device token. */
  send(params: {
    deviceToken: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }): Promise<Result<{ messageId: string }>>;
}

/**
 * Print Adapter interface.
 *
 * Implement this interface to integrate with a receipt/label printer
 * (e.g. Epson ESC/POS, Star Line Mode printers).
 */
export interface PrintAdapter {
  /** Unique provider identifier (e.g. "esc_pos", "star", "console"). */
  providerId: string;
  /** Send a print job to the given printer. */
  print(params: {
    printerId: string;
    content: Record<string, unknown>;
    format: "esc_pos" | "star_line" | "label";
  }): Promise<Result<{ jobId: string }>>;
}

/** Configuration object for notification adapters. */
export interface NotificationAdapters {
  sms?: SMSAdapter;
  push?: PushAdapter;
  print?: PrintAdapter;
}
