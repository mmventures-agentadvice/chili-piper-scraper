/**
 * Order Chili Piper (same-day) slot labels for ±W minute fallback after exact match fails.
 * Future bucket: (0, W] minutes ahead, closest first. Past: [-W, 0), closest to target first.
 */

export type SlotFallbackWindowMinutes = 15 | 30;

export type ChiliSlotForFallback = {
  /** Wall-clock label for booking response / matching (e.g. "1:30 PM") */
  label: string;
  /** Minutes from midnight on the booking day */
  minutes: number;
};

const SLOT_TEST_ID_RE = /^slot-(\d{1,2}):(\d{2})(AM|PM)$/i;

/** Parse minutes 0..1439 from Chili `data-test-id` like `slot-1:30PM`. */
export function parseMinutesFromChiliSlotTestId(dataTestId: string): number | null {
  const m = SLOT_TEST_ID_RE.exec(dataTestId.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (minute > 59 || hour < 1 || hour > 12) return null;
  if (ap === 'PM' && hour !== 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/**
 * Parse "1:30 PM", "1:30PM", "12:00 AM" to minutes from midnight.
 */
export function parseWallTimeToMinutes(time: string): number | null {
  const t = time.trim().replace(/\s+/g, ' ');
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (minute > 59 || hour < 1 || hour > 12) return null;
  if (ap === 'PM' && hour !== 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/**
 * Signed difference in minutes: booked wall time minus requested (same calendar day).
 * Negative when the booked slot is earlier than requested (e.g. requested 2:00 PM, booked 1:45 PM → -15).
 * Positive when the booked slot is later (e.g. booked 2:15 PM → +15).
 * Returns 0 when either value is unparseable or both resolve to the same minutes.
 */
export function computeBookedMismatchAmountMinutes(
  requestedTime: string,
  bookedTime: string
): number {
  const req = parseWallTimeToMinutes(requestedTime);
  const book = parseWallTimeToMinutes(bookedTime);
  if (req === null || book === null) return 0;
  return book - req;
}

function normalizeDisplayLabel(label: string, minutes: number): string {
  const parsed = parseWallTimeToMinutes(label);
  if (parsed === minutes) {
    const m = /^(\d{1,2}:\d{2})\s*(AM|PM)$/i.exec(label.trim().replace(/\s+/g, ' '));
    if (m) {
      return `${m[1]} ${m[2].toUpperCase()}`;
    }
  }
  const h24 = Math.floor(minutes / 60);
  const min = minutes % 60;
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const ap = h24 >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(min).padStart(2, '0')} ${ap}`;
}

/**
 * Build ordered list of slot labels to try after an exact match has failed.
 * Excludes slots outside the window. If multiple slots share the same minutes, one label is kept.
 */
export function orderChiliSlotFallbackLabels(
  targetMinutes: number,
  windowMinutes: SlotFallbackWindowMinutes,
  slots: ChiliSlotForFallback[]
): string[] {
  const byMinute = new Map<number, string>();
  for (const s of slots) {
    const m = s.minutes;
    if (m < 0 || m >= 1440) continue;
    if (!byMinute.has(m)) {
      byMinute.set(m, normalizeDisplayLabel(s.label, m));
    }
  }

  const entries = [...byMinute.entries()].map(([minutes, label]) => ({
    minutes,
    label,
    delta: minutes - targetMinutes,
  }));

  const future = entries
    .filter((e) => e.delta > 0 && e.delta <= windowMinutes)
    .sort((a, b) => a.delta - b.delta);

  const past = entries
    .filter((e) => e.delta < 0 && e.delta >= -windowMinutes)
    .sort((a, b) => b.delta - a.delta);

  return [...future, ...past].map((e) => e.label);
}

export class ChiliSlotWindowExhaustedError extends Error {
  override readonly name = 'ChiliSlotWindowExhaustedError';

  constructor(
    readonly requestedDate: string,
    readonly requestedTime: string,
    readonly slotFallbackWindowMinutes: SlotFallbackWindowMinutes,
    readonly availableSlotLabels: string[]
  ) {
    super(
      `No bookable slot within ±${slotFallbackWindowMinutes} minutes of ${requestedTime} on ${requestedDate}`
    );
  }
}
