import { getCentralOffsetForDate } from '@/lib/central-timezone';
import { normalizeTimeForCalendly } from '@/lib/calendly-booker';

/**
 * Parse Calendly-normalized time like "9:30am" or "1:25pm" to 24h clock.
 */
function parseNormalizedCalendlyTimeTo24h(normalized: string): { h: number; mi: number } | null {
  const m = normalized.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const mi = Number(m[2]);
  const ap = m[3].toLowerCase();
  if (hour < 1 || hour > 12 || Number.isNaN(mi) || mi < 0 || mi > 59) return null;
  if (ap === 'pm' && hour !== 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  return { h: hour, mi };
}

/**
 * Unix seconds for wall clock `time12h` on `dateYmd` in America/Chicago.
 * Offset comes from {@link getCentralOffsetForDate} (DST by calendar date), not from CST/CDT text in the original string.
 */
export function unixSecondsInCentral(dateYmd: string, time12h: string): number | null {
  const normalized = normalizeTimeForCalendly(time12h);
  const parsed = parseNormalizedCalendlyTimeTo24h(normalized);
  if (!parsed) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = getCentralOffsetForDate(dateYmd);
  const isoLocal = `${dateYmd}T${pad(parsed.h)}:${pad(parsed.mi)}:00${offset}`;
  const ms = new Date(isoLocal).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}
