import type { Frame, Page } from 'playwright';
import { pickChiliSlotWithFallback } from '@/lib/chili-slot-picker';
import type { SlotFallbackWindowMinutes } from '@/lib/slot-fallback-window';

type CalendarContext = Page | Frame;

const MAX_WEEK_NAV = 26;
const DAY_BUTTON = 'button[data-test-id^="days:"]';

function parseIsoDate(ymd: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) throw new Error(`Invalid target date ${ymd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    throw new Error(`Invalid target date ${ymd}`);
  }
  return { y, m: mo, d };
}

/** Parse "Mar 20 2026" from Chili `data-test-id` like days:Mar/Fri Mar 20 2026 00:00:00 ... */
function parseDateFromChiliDayTestId(testId: string): { y: number; m: number; d: number } | null {
  const re = /\b([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\b/;
  const hit = re.exec(testId);
  if (!hit) return null;
  const parsed = new Date(`${hit[1]} ${hit[2]}, ${hit[3]}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return { y: parsed.getFullYear(), m: parsed.getMonth() + 1, d: parsed.getDate() };
}

function sameYmd(
  a: { y: number; m: number; d: number },
  b: { y: number; m: number; d: number }
): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

function toUtcMidnight(t: { y: number; m: number; d: number }): number {
  return Date.UTC(t.y, t.m - 1, t.d);
}

async function isControlDisabled(el: { evaluate: (fn: (e: HTMLElement) => boolean) => Promise<boolean> }): Promise<boolean> {
  return el.evaluate(
    (e) =>
      (e as HTMLButtonElement).disabled ||
      e.getAttribute('aria-disabled') === 'true' ||
      e.hasAttribute('disabled')
  );
}

async function findArrow(ctx: CalendarContext, page: Page, dataId: string) {
  let el = await ctx.$(`[data-id="${dataId}"]`);
  if (!el) el = await page.$(`[data-id="${dataId}"]`);
  return el;
}

type DayRow = {
  testId: string;
  ymd: { y: number; m: number; d: number };
  disabled: boolean;
};

async function readVisibleDays(ctx: CalendarContext): Promise<DayRow[]> {
  const handles = await ctx.$$(DAY_BUTTON);
  const rows: DayRow[] = [];
  for (const h of handles) {
    const testId = await h.getAttribute('data-test-id');
    if (!testId) continue;
    const ymd = parseDateFromChiliDayTestId(testId);
    if (!ymd) continue;
    const disabled = await h.evaluate(
      (el) =>
        (el as HTMLButtonElement).disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.hasAttribute('disabled')
    );
    rows.push({ testId, ymd, disabled });
  }
  return rows;
}

async function clickDayForTarget(ctx: CalendarContext, target: { y: number; m: number; d: number }): Promise<boolean> {
  const handles = await ctx.$$(DAY_BUTTON);
  for (const h of handles) {
    const testId = await h.getAttribute('data-test-id');
    if (!testId) continue;
    const ymd = parseDateFromChiliDayTestId(testId);
    if (!ymd || !sameYmd(ymd, target)) continue;
    const disabled = await h.evaluate(
      (el) =>
        (el as HTMLButtonElement).disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.hasAttribute('disabled')
    );
    if (disabled) {
      throw new Error(`Day not bookable (no availability) for date ${target.y}-${String(target.m).padStart(2, '0')}-${String(target.d).padStart(2, '0')}`);
    }
    await h.click();
    return true;
  }
  return false;
}

export type LuxuryBookLog = (msg: string, data?: Record<string, unknown>) => void;

export async function bookLuxuryPresenceSlot(
  calendarContext: CalendarContext,
  page: Page,
  params: {
    date: string;
    time: string;
    firstName: string;
    lastName: string;
    email: string;
    slotFallbackWindowMinutes: SlotFallbackWindowMinutes;
    log: LuxuryBookLog;
  }
): Promise<{ bookedTime: string }> {
  const { date, time, firstName, lastName, email, slotFallbackWindowMinutes, log } = params;

  if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
    throw new Error('firstName, lastName, and email are required for Luxury Presence booking');
  }

  const target = parseIsoDate(date);
  log('Luxury booking: waiting for calendar chrome', { date, time });

  await calendarContext.waitForSelector('[data-id="calendar-arrows-button-next"]', { timeout: 15000 });
  await calendarContext.waitForSelector(DAY_BUTTON, { timeout: 15000 });

  let navigations = 0;
  let dayChosen = false;
  while (navigations < MAX_WEEK_NAV) {
    const rows = await readVisibleDays(calendarContext);
    if (rows.length === 0) {
      throw new Error(`Day not found for date ${date}: no day buttons in view`);
    }

    const clicked = await clickDayForTarget(calendarContext, target);
    if (clicked) {
      log('Luxury booking: clicked target day', { date });
      dayChosen = true;
      break;
    }

    const times = rows.map((r) => toUtcMidnight(r.ymd));
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const targetT = toUtcMidnight(target);

    if (targetT > maxT) {
      const nextBtn = await findArrow(calendarContext, page, 'calendar-arrows-button-next');
      if (!nextBtn) throw new Error(`Day not found for date ${date}: next-week control missing`);
      if (await isControlDisabled(nextBtn)) {
        throw new Error(`Day not found for date ${date}: target is after last visible week`);
      }
      await nextBtn.click();
      await page.waitForTimeout(600);
      navigations += 1;
      continue;
    }

    if (targetT < minT) {
      const prevBtn = await findArrow(calendarContext, page, 'calendar-arrows-button-prev');
      if (!prevBtn) throw new Error(`Day not found for date ${date}: previous-week control missing`);
      if (await isControlDisabled(prevBtn)) {
        throw new Error(
          `Day not found for date ${date}: calendar cannot scroll to earlier weeks (date may be in the past or outside Chili Piper's bookable range).`
        );
      }
      await prevBtn.click();
      await page.waitForTimeout(600);
      navigations += 1;
      continue;
    }

    throw new Error(`Day not found for date ${date}`);
  }

  if (!dayChosen) {
    throw new Error(`Day not found for date ${date}: exceeded week navigation limit`);
  }

  try {
    await calendarContext.waitForSelector(
      '[data-id="calendar-slots-header"], [data-id="calendar-slot"], button[data-test-id^="slot-"]',
      { timeout: 8000 }
    );
  } catch {
    await page.waitForTimeout(1000);
  }

  const bookedTime = await pickChiliSlotWithFallback(
    calendarContext,
    date,
    time,
    slotFallbackWindowMinutes
  );
  log('Luxury booking: clicked slot', { bookedTime, requestedTime: time });

  await page.waitForTimeout(1000);

  const formContext = calendarContext;
  await formContext.waitForSelector(
    '[data-test-id="GuestFormField-PersonFirstName"], [data-test-id="GuestForm-submit-button"]',
    { timeout: 8000 }
  );
  await formContext.fill('[data-test-id="GuestFormField-PersonFirstName"]', firstName);
  await formContext.fill('[data-test-id="GuestFormField-PersonLastName"]', lastName);
  await formContext.fill('[data-test-id="GuestFormField-PersonEmail"]', email);

  const confirmSelectors = [
    '[data-test-id="GuestForm-submit-button"]',
    '[data-id="form-confirm-button"]',
    'button:has-text("Confirm Meeting")',
  ];
  let confirmed = false;
  for (const sel of confirmSelectors) {
    try {
      await formContext.click(sel, { timeout: 2500 });
      log('Luxury booking: clicked Confirm Meeting', { sel });
      confirmed = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!confirmed) {
    throw new Error('Could not click Confirm Meeting on guest form');
  }

  await page.waitForTimeout(1500);
  return { bookedTime };
}
