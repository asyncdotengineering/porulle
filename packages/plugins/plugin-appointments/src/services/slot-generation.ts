import type { TimeSlot, SlotGenerationParams } from "../types.js";

/**
 * Pure function: generates available time slots for a given date.
 *
 * No DB access — all inputs passed as parameters.
 * Handles: schedule hours, breaks, buffer time, existing bookings,
 * min notice, max advance, and timezone conversion.
 */
export function generateSlots(params: SlotGenerationParams): TimeSlot[] {
  const {
    date,
    schedule,
    durationMinutes,
    bufferBeforeMinutes = 0,
    bufferAfterMinutes = 0,
    breaks = [],
    existingBookings = [],
    minNoticeMinutes = 0,
    maxAdvanceDays = 0,
    timezone,
    now = new Date(),
  } = params;

  // Day off — no slots
  if (!schedule) return [];

  // Parse schedule times into absolute Date objects for the given date in the provider's timezone
  const dayStart = parseTimeInTimezone(date, schedule.startTime, timezone);
  const dayEnd = parseTimeInTimezone(date, schedule.endTime, timezone);

  if (dayEnd <= dayStart) return [];

  // Generate candidate slots
  const totalSlotMinutes = bufferBeforeMinutes + durationMinutes + bufferAfterMinutes;
  const candidates: TimeSlot[] = [];

  let cursor = dayStart.getTime();
  while (cursor + totalSlotMinutes * 60_000 <= dayEnd.getTime()) {
    const slotStart = new Date(cursor + bufferBeforeMinutes * 60_000);
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
    const blockEnd = new Date(slotEnd.getTime() + bufferAfterMinutes * 60_000);

    candidates.push({ start: slotStart, end: slotEnd });

    // Advance by duration + buffer after (so buffers don't overlap)
    cursor = blockEnd.getTime();
  }

  // Filter out slots that overlap with breaks
  const breakRanges = breaks.map((b) => ({
    start: parseTimeInTimezone(date, b.startTime, timezone),
    end: parseTimeInTimezone(date, b.endTime, timezone),
  }));

  let filtered = candidates.filter((slot) => {
    // The slot's full block (including buffers) must not overlap any break
    const blockStart = new Date(slot.start.getTime() - bufferBeforeMinutes * 60_000);
    const blockEnd = new Date(slot.end.getTime() + bufferAfterMinutes * 60_000);
    return !breakRanges.some((br) => blockStart < br.end && blockEnd > br.start);
  });

  // Filter out slots that overlap with existing bookings
  filtered = filtered.filter((slot) => {
    return !existingBookings.some((booking) =>
      slot.start < booking.endTime && slot.end > booking.startTime
    );
  });

  // Filter out slots that violate min notice
  if (minNoticeMinutes > 0) {
    const earliestStart = new Date(now.getTime() + minNoticeMinutes * 60_000);
    filtered = filtered.filter((slot) => slot.start >= earliestStart);
  }

  // Filter out slots that violate max advance
  if (maxAdvanceDays > 0) {
    const latestStart = new Date(now.getTime() + maxAdvanceDays * 24 * 60 * 60_000);
    filtered = filtered.filter((slot) => slot.start <= latestStart);
  }

  return filtered;
}

/**
 * Parses a time string (HH:mm) on a given date in a specific timezone,
 * returning a UTC Date object.
 */
export function parseTimeInTimezone(date: Date, time: string, timezone: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  // Build a date string in the target timezone
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const h = String(hours).padStart(2, "0");
  const m = String(minutes).padStart(2, "0");

  // Create date in the provider's timezone using Intl
  const dateStr = `${year}-${month}-${day}T${h}:${m}:00`;

  // Use a formatter to figure out the UTC offset for this timezone at this date/time
  const utcDate = new Date(dateStr + "Z");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Find the offset by comparing what UTC time produces the desired local time
  // Binary search-like approach: try the UTC date, see what local time it maps to,
  // and adjust.
  const parts = formatter.formatToParts(utcDate);
  const localHour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const localMinute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const localDay = Number(parts.find((p) => p.type === "day")?.value ?? 0);
  const localMonth = Number(parts.find((p) => p.type === "month")?.value ?? 0);

  // Calculate the difference between the local time at UTC and our target
  const targetMinutes = hours! * 60 + minutes!;
  let localMinutes = localHour * 60 + localMinute;

  // Handle day/month boundary crossings
  const targetDay = date.getDate();
  if (localDay !== targetDay || localMonth !== date.getMonth() + 1) {
    // Day changed — adjust by a full day if needed
    if (localDay > targetDay || localMonth > date.getMonth() + 1) {
      localMinutes += 24 * 60; // local is ahead
    } else {
      localMinutes -= 24 * 60; // local is behind
    }
  }

  const offsetMinutes = localMinutes - targetMinutes;

  // The UTC time = target time + offset (since local = UTC - offset means UTC = local + offset)
  // Actually: if local shows 14:30 when UTC is 09:00, offset = +5:30
  // We want UTC time that corresponds to target local time
  // UTC = targetTime - offset... no: local = UTC + offset => UTC = local - offset
  // offsetMinutes = local - target. If we set UTC = utcDate - offsetMinutes * 60000
  // that gives us: local_of_result = (utcDate - offsetMinutes*60000) + offset
  //              = utcDate + offset - offsetMinutes*60000
  //              = utcDate + offset - (local - target)*60000
  // Hmm, let me think differently.
  //
  // We know: formatter(utcDate) = localTime
  // We want: formatter(result) = targetTime
  // So: result = utcDate - (localTime - targetTime) * 60000
  //            = utcDate - offsetMinutes * 60000

  return new Date(utcDate.getTime() - offsetMinutes * 60_000);
}
