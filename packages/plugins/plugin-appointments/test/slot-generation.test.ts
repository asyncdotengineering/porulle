import { describe, expect, it } from "vitest";
import { generateSlots, parseTimeInTimezone } from "../src/services/slot-generation.js";
import type { SlotGenerationParams } from "../src/types.js";

const UTC = "UTC";

function makeDate(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

describe("slot generation (pure function)", () => {
  it("generates 30-min slots from 9am-5pm (16 slots)", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      timezone: UTC,
    });
    expect(slots).toHaveLength(16);
    // First slot: 09:00-09:30
    expect(slots[0]!.start.getUTCHours()).toBe(9);
    expect(slots[0]!.start.getUTCMinutes()).toBe(0);
    expect(slots[0]!.end.getUTCHours()).toBe(9);
    expect(slots[0]!.end.getUTCMinutes()).toBe(30);
    // Last slot: 16:30-17:00
    expect(slots[15]!.start.getUTCHours()).toBe(16);
    expect(slots[15]!.start.getUTCMinutes()).toBe(30);
  });

  it("generates 60-min slots from 9am-5pm (8 slots)", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 60,
      timezone: UTC,
    });
    expect(slots).toHaveLength(8);
    expect(slots[0]!.start.getUTCHours()).toBe(9);
    expect(slots[7]!.start.getUTCHours()).toBe(16);
  });

  it("respects buffer time (15 min before + after reduces available slots)", () => {
    // 8 hours = 480 min. Each slot takes 30 + 15 + 15 = 60 min total block
    // So 480/60 = 8 slots
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
      timezone: UTC,
    });
    expect(slots).toHaveLength(8);
    // First slot starts at 09:15 (after 15min buffer)
    expect(slots[0]!.start.getUTCHours()).toBe(9);
    expect(slots[0]!.start.getUTCMinutes()).toBe(15);
    expect(slots[0]!.end.getUTCHours()).toBe(9);
    expect(slots[0]!.end.getUTCMinutes()).toBe(45);
  });

  it("subtracts breaks from available slots (lunch 12-1 removes 2 slots)", () => {
    const slotsWithoutBreak = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      timezone: UTC,
    });
    const slotsWithBreak = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      breaks: [{ startTime: "12:00", endTime: "13:00" }],
      timezone: UTC,
    });
    // 16 - 2 = 14 (the 12:00 and 12:30 slots are removed)
    expect(slotsWithoutBreak).toHaveLength(16);
    expect(slotsWithBreak).toHaveLength(14);

    // Verify the break slots are actually missing
    const breakSlots = slotsWithBreak.filter((s) => {
      const h = s.start.getUTCHours();
      return h === 12;
    });
    expect(breakSlots).toHaveLength(0);
  });

  it("subtracts existing bookings from available slots", () => {
    // Book the 10:00-10:30 slot
    const existingBooking = {
      startTime: new Date(Date.UTC(2026, 2, 20, 10, 0)),
      endTime: new Date(Date.UTC(2026, 2, 20, 10, 30)),
    };
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      existingBookings: [existingBooking],
      timezone: UTC,
    });
    // 16 - 1 = 15
    expect(slots).toHaveLength(15);
    // The 10:00 slot should be gone
    const tenOClockSlot = slots.find((s) => s.start.getUTCHours() === 10 && s.start.getUTCMinutes() === 0);
    expect(tenOClockSlot).toBeUndefined();
  });

  it("returns empty for day-off override", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: null, // day off
      durationMinutes: 30,
      timezone: UTC,
    });
    expect(slots).toHaveLength(0);
  });

  it("uses override hours instead of weekly schedule when override exists", () => {
    // Override: work only 10am-2pm (4 hours = 8 × 30-min slots)
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "10:00", endTime: "14:00" },
      durationMinutes: 30,
      timezone: UTC,
    });
    expect(slots).toHaveLength(8);
    expect(slots[0]!.start.getUTCHours()).toBe(10);
    expect(slots[7]!.end.getUTCHours()).toBe(14);
  });

  it("enforces min notice (can't book slots starting in < 60 min)", () => {
    // Set "now" to 10:30 UTC on the same day, with 60 min notice
    const now = new Date(Date.UTC(2026, 2, 20, 10, 30));
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      minNoticeMinutes: 60,
      timezone: UTC,
      now,
    });
    // Earliest allowed: 11:30. Slots from 11:30 to 16:30 = 11 slots
    expect(slots.every((s) => s.start >= new Date(Date.UTC(2026, 2, 20, 11, 30)))).toBe(true);
    expect(slots).toHaveLength(11);
  });

  it("enforces max advance (can't book slots > 60 days ahead)", () => {
    // Set "now" to 2026-01-01, max advance 60 days → latest = 2026-03-02
    // Query date 2026-03-20 → all slots should be filtered out
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0));
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      maxAdvanceDays: 60,
      timezone: UTC,
      now,
    });
    expect(slots).toHaveLength(0);
  });

  it("handles timezone conversion (provider in Asia/Colombo, query in UTC)", () => {
    // Asia/Colombo is UTC+5:30
    // Provider works 09:00-17:00 local = 03:30-11:30 UTC
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 60,
      timezone: "Asia/Colombo",
    });
    expect(slots.length).toBeGreaterThan(0);
    // First slot should start at 09:00 Colombo time = 03:30 UTC
    expect(slots[0]!.start.getUTCHours()).toBe(3);
    expect(slots[0]!.start.getUTCMinutes()).toBe(30);
    // Last slot should end at 17:00 Colombo = 11:30 UTC
    const lastSlot = slots[slots.length - 1]!;
    expect(lastSlot.end.getUTCHours()).toBe(11);
    expect(lastSlot.end.getUTCMinutes()).toBe(30);
  });

  it("handles multiple breaks on the same day", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      breaks: [
        { startTime: "12:00", endTime: "12:30" }, // half-hour break
        { startTime: "15:00", endTime: "15:30" }, // afternoon break
      ],
      timezone: UTC,
    });
    // 16 slots - 1 (12:00) - 1 (15:00) = 14
    expect(slots).toHaveLength(14);
  });

  it("handles multiple existing bookings", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      existingBookings: [
        { startTime: new Date(Date.UTC(2026, 2, 20, 9, 0)), endTime: new Date(Date.UTC(2026, 2, 20, 9, 30)) },
        { startTime: new Date(Date.UTC(2026, 2, 20, 14, 0)), endTime: new Date(Date.UTC(2026, 2, 20, 14, 30)) },
      ],
      timezone: UTC,
    });
    expect(slots).toHaveLength(14);
  });

  it("generates zero slots when schedule window is too short for duration", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "09:20" },
      durationMinutes: 30,
      timezone: UTC,
    });
    expect(slots).toHaveLength(0);
  });

  it("generates 15-min slots from 9am-12pm (12 slots)", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "12:00" },
      durationMinutes: 15,
      timezone: UTC,
    });
    expect(slots).toHaveLength(12);
  });

  it("slots do not overlap with each other", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 45,
      timezone: UTC,
    });
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]!.start.getTime()).toBeGreaterThanOrEqual(slots[i - 1]!.end.getTime());
    }
  });

  it("all slots fall within schedule window", () => {
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "10:00", endTime: "14:00" },
      durationMinutes: 30,
      timezone: UTC,
    });
    const dayStart = new Date(Date.UTC(2026, 2, 20, 10, 0));
    const dayEnd = new Date(Date.UTC(2026, 2, 20, 14, 0));
    for (const slot of slots) {
      expect(slot.start.getTime()).toBeGreaterThanOrEqual(dayStart.getTime());
      expect(slot.end.getTime()).toBeLessThanOrEqual(dayEnd.getTime());
    }
  });

  it("buffer slots reduce total count correctly with 10-min buffer", () => {
    // 4 hours = 240 min. Each slot: 10 buffer + 30 duration + 10 buffer = 50 min
    // 240/50 = 4.8 → 4 slots
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "13:00" },
      durationMinutes: 30,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 10,
      timezone: UTC,
    });
    expect(slots).toHaveLength(4);
  });

  it("booking that partially overlaps a slot removes it", () => {
    // Booking from 10:15-10:45 should block the 10:00-10:30 AND 10:30-11:00 slots
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 30,
      existingBookings: [
        { startTime: new Date(Date.UTC(2026, 2, 20, 10, 15)), endTime: new Date(Date.UTC(2026, 2, 20, 10, 45)) },
      ],
      timezone: UTC,
    });
    // Should remove 10:00-10:30 (overlaps) and 10:30-11:00 (overlaps)
    expect(slots).toHaveLength(14);
  });

  it("max advance allows slots within the window", () => {
    // now = 2026-03-15, max advance 30 days → latest = 2026-04-14
    // Query date 2026-03-20 → within window → should get slots
    const now = new Date(Date.UTC(2026, 2, 15, 0, 0));
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 60,
      maxAdvanceDays: 30,
      timezone: UTC,
      now,
    });
    expect(slots.length).toBeGreaterThan(0);
  });

  it("handles America/New_York timezone", () => {
    // America/New_York is UTC-4 (EDT in March)
    // Provider works 09:00-17:00 local = 13:00-21:00 UTC
    const slots = generateSlots({
      date: makeDate(2026, 3, 20),
      schedule: { startTime: "09:00", endTime: "17:00" },
      durationMinutes: 60,
      timezone: "America/New_York",
    });
    expect(slots.length).toBe(8);
    expect(slots[0]!.start.getUTCHours()).toBe(13);
  });
});

describe("parseTimeInTimezone", () => {
  it("parses UTC time correctly", () => {
    const result = parseTimeInTimezone(makeDate(2026, 3, 20), "09:00", "UTC");
    expect(result.getUTCHours()).toBe(9);
    expect(result.getUTCMinutes()).toBe(0);
  });

  it("parses Asia/Colombo time correctly (UTC+5:30)", () => {
    const result = parseTimeInTimezone(makeDate(2026, 3, 20), "09:00", "Asia/Colombo");
    // 09:00 Colombo = 03:30 UTC
    expect(result.getUTCHours()).toBe(3);
    expect(result.getUTCMinutes()).toBe(30);
  });

  it("parses midnight correctly", () => {
    const result = parseTimeInTimezone(makeDate(2026, 3, 20), "00:00", "UTC");
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
  });

  it("parses end of day correctly", () => {
    const result = parseTimeInTimezone(makeDate(2026, 3, 20), "23:59", "UTC");
    expect(result.getUTCHours()).toBe(23);
    expect(result.getUTCMinutes()).toBe(59);
  });
});
