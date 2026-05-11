import { eq, and, gte, lte } from "@porulle/core/drizzle";
import { weeklyAvailability, availabilityOverrides, breaks, bookings } from "../schema.js";
import { generateSlots } from "./slot-generation.js";
import type { Db, DaySchedule, BreakPeriod, ExistingBooking, TimeSlot } from "../types.js";

export class SlotService {
  constructor(
    private db: Db,
    private defaults: {
      minNoticeMinutes: number;
      maxAdvanceDays: number;
    } = { minNoticeMinutes: 0, maxAdvanceDays: 60 },
  ) {}

  async getAvailableSlots(
    providerId: string,
    serviceTypeId: string,
    date: Date,
    durationMinutes: number,
    bufferBeforeMinutes: number,
    bufferAfterMinutes: number,
    timezone: string,
    now?: Date,
  ): Promise<TimeSlot[]> {
    const dayOfWeek = date.getDay(); // 0 = Sunday
    const dateStr = formatDateStr(date);

    // Check for date-level override
    const [override] = await this.db
      .select()
      .from(availabilityOverrides)
      .where(
        and(
          eq(availabilityOverrides.providerId, providerId),
          eq(availabilityOverrides.date, dateStr),
        ),
      );

    let schedule: DaySchedule | null;
    if (override) {
      if (!override.isAvailable) {
        schedule = null; // Day off
      } else {
        schedule = {
          startTime: override.startTime!,
          endTime: override.endTime!,
        };
      }
    } else {
      // Fall back to weekly availability
      const weeklyRows = await this.db
        .select()
        .from(weeklyAvailability)
        .where(
          and(
            eq(weeklyAvailability.providerId, providerId),
            eq(weeklyAvailability.dayOfWeek, dayOfWeek),
          ),
        );

      if (weeklyRows.length === 0) {
        schedule = null;
      } else {
        // Use the first matching row (multiple rows for same day not expected)
        schedule = {
          startTime: weeklyRows[0]!.startTime,
          endTime: weeklyRows[0]!.endTime,
        };
      }
    }

    // Get breaks for this day
    const breakRows = await this.db
      .select()
      .from(breaks)
      .where(eq(breaks.providerId, providerId));

    const dayBreaks: BreakPeriod[] = breakRows
      .filter((b) => b.dayOfWeek == null || b.dayOfWeek === dayOfWeek)
      .map((b) => ({ startTime: b.startTime, endTime: b.endTime }));

    // Get existing bookings for this date
    const dayStartUTC = new Date(date);
    dayStartUTC.setHours(0, 0, 0, 0);
    const dayEndUTC = new Date(dayStartUTC);
    dayEndUTC.setDate(dayEndUTC.getDate() + 1);

    const bookingRows = await this.db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.providerId, providerId),
          gte(bookings.startTime, dayStartUTC),
          lte(bookings.startTime, dayEndUTC),
          // Only count non-cancelled bookings
        ),
      );

    const existingBookings: ExistingBooking[] = bookingRows
      .filter((b) => b.status !== "cancelled")
      .map((b) => ({
        startTime: b.startTime,
        endTime: b.endTime,
      }));

    return generateSlots({
      date,
      schedule,
      durationMinutes,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      breaks: dayBreaks,
      existingBookings,
      minNoticeMinutes: this.defaults.minNoticeMinutes,
      maxAdvanceDays: this.defaults.maxAdvanceDays,
      timezone,
      now,
    });
  }
}

function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
