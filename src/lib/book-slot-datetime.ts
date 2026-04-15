/**
 * Shared date/time parsing for book-slot and unified /api/book (e.g. Brivity).
 * Prefer `dateTime` when present; otherwise `date` + `time`.
 */

/**
 * Parse date/time string like "November 13, 2025 at 1:25 PM CST"
 * Returns { date: "2025-11-13", time: "1:25 PM" }
 */
export function parseDateTime(dateTimeString: string): { date: string; time: string } | null {
  try {
    // Remove timezone info (CST, EST, etc.) — wall time is interpreted in America/Chicago downstream.
    const cleaned = dateTimeString.replace(/\s+(CST|EST|PST|CDT|EDT|PDT|UTC|GMT)[\s,]*$/i, '').trim();

    const match = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

    if (!match) {
      const altMatch = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (altMatch) {
        const [, monthName, day, year, hour, minute, ampm] = altMatch;
        const monthMap: Record<string, number> = {
          january: 1,
          jan: 1,
          february: 2,
          feb: 2,
          march: 3,
          mar: 3,
          april: 4,
          apr: 4,
          may: 5,
          june: 6,
          jun: 6,
          july: 7,
          jul: 7,
          august: 8,
          aug: 8,
          september: 9,
          sep: 9,
          sept: 9,
          october: 10,
          oct: 10,
          november: 11,
          nov: 11,
          december: 12,
          dec: 12,
        };

        const month = monthMap[monthName.toLowerCase()];
        if (!month) return null;

        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const time = `${hour}:${minute} ${ampm.toUpperCase()}`;
        return { date, time };
      }
      return null;
    }

    const [, monthName, day, year, hour, minute, ampm] = match;
    const monthMap: Record<string, number> = {
      january: 1,
      jan: 1,
      february: 2,
      feb: 2,
      march: 3,
      mar: 3,
      april: 4,
      apr: 4,
      may: 5,
      june: 6,
      jun: 6,
      july: 7,
      jul: 7,
      august: 8,
      aug: 8,
      september: 9,
      sep: 9,
      sept: 9,
      october: 10,
      oct: 10,
      november: 11,
      nov: 11,
      december: 12,
      dec: 12,
    };

    const month = monthMap[monthName.toLowerCase()];
    if (!month) return null;

    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const time = `${hour}:${minute} ${ampm.toUpperCase()}`;
    return { date, time };
  } catch (error) {
    console.error('Error parsing date/time:', error);
    return null;
  }
}

/**
 * Parse separate date (YYYY-MM-DD) and time (12h with AM/PM) into the same shape as {@link parseDateTime}.
 */
export function parseSplitDateAndTime(
  dateStr: string,
  timeStr: string
): { date: string; time: string } | null {
  const date = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, mo, d] = date.split('-').map(Number);
  const dt = new Date(y!, mo! - 1, d!);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo! - 1 || dt.getDate() !== d) return null;

  const t = timeStr.trim();
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2];
  const ampm = m[3].toUpperCase();
  if (hour < 1 || hour > 12) return null;
  const mi = Number(minute);
  if (Number.isNaN(mi) || mi < 0 || mi > 59) return null;
  const time = `${hour}:${minute} ${ampm}`;
  return { date, time };
}

/**
 * Prefer `dateTime` when present; otherwise require `date` + `time` (YYYY-MM-DD and e.g. 1:25 PM).
 */
export function resolveBookSlotDateTime(body: {
  dateTime?: string;
  date?: string;
  time?: string;
}): { date: string; time: string } | null {
  const rawDt = body.dateTime;
  const hasDt = typeof rawDt === 'string' && rawDt.trim().length > 0;
  const rawDate = body.date;
  const rawTime = body.time;
  const hasSplit =
    typeof rawDate === 'string' &&
    rawDate.trim().length > 0 &&
    typeof rawTime === 'string' &&
    rawTime.trim().length > 0;

  if (hasDt) {
    return parseDateTime(rawDt!.trim());
  }
  if (hasSplit) {
    return parseSplitDateAndTime(rawDate!.trim(), rawTime!.trim());
  }
  return null;
}
