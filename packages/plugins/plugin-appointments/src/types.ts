export type { PluginDb as Db } from "@porulle/core";

// ─── Booking Status ─────────────────────────────────────────────────────────

export type BookingStatus = "provisional" | "confirmed" | "completed" | "cancelled" | "no_show";

export const BOOKING_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  provisional: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};

// ─── Slot Types ─────────────────────────────────────────────────────────────

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface DaySchedule {
  startTime: string; // "09:00"
  endTime: string;   // "17:00"
}

export interface BreakPeriod {
  startTime: string; // "12:00"
  endTime: string;   // "13:00"
}

export interface ExistingBooking {
  startTime: Date;
  endTime: Date;
}

export interface SlotGenerationParams {
  date: Date;                         // The date to generate slots for
  schedule: DaySchedule | null;       // null = day off
  durationMinutes: number;
  bufferBeforeMinutes?: number | undefined;
  bufferAfterMinutes?: number | undefined;
  breaks?: BreakPeriod[] | undefined;
  existingBookings?: ExistingBooking[] | undefined;
  minNoticeMinutes?: number | undefined;
  maxAdvanceDays?: number | undefined;
  timezone: string;                   // Provider's timezone (e.g., "Asia/Colombo")
  now?: Date | undefined;             // Current time (for min notice / max advance checks)
}

// ─── Plugin Options ─────────────────────────────────────────────────────────

export interface AppointmentPluginOptions {
  defaultDurationMinutes?: number;
  defaultBufferBeforeMinutes?: number;
  defaultBufferAfterMinutes?: number;
  minNoticeMinutes?: number;
  maxAdvanceDays?: number;
  defaultTimezone?: string;
  autoConfirmCashBookings?: boolean;
}
