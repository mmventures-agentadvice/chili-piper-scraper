/**
 * Chili Piper calendar DOM: collect enabled slots and pick exact or ±window fallback.
 */

import {
  ChiliSlotForFallback,
  ChiliSlotWindowExhaustedError,
  orderChiliSlotFallbackLabels,
  parseMinutesFromChiliSlotTestId,
  parseWallTimeToMinutes,
  type SlotFallbackWindowMinutes,
} from './slot-fallback-window';

export function formatTimeForChiliSlotId(time: string): string {
  return time.replace(/\s+/g, '').toUpperCase();
}

type RawChiliSlotRow = {
  dataTestId: string;
  text: string;
  disabled: boolean;
};

export async function collectRawChiliSlotRows(calendarContext: {
  $$eval: (sel: string, fn: (buttons: Element[]) => RawChiliSlotRow[]) => Promise<RawChiliSlotRow[]>;
}): Promise<RawChiliSlotRow[]> {
  return calendarContext.$$eval(
    '[data-id="calendar-slot"], button[data-test-id^="slot-"]',
    (buttons: Element[]) =>
      buttons.map((b: Element) => ({
        dataTestId: b.getAttribute('data-test-id') || '',
        text: (b.textContent || '').trim(),
        disabled:
          b.hasAttribute('disabled') ||
          (b as HTMLButtonElement).disabled ||
          b.getAttribute('aria-disabled') === 'true',
      }))
  );
}

function normalizeTimeForComparison(timeStr: string): string {
  return timeStr
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/^0+/, '');
}

function timesMatchForChili(time1: string, time2: string): boolean {
  return normalizeTimeForComparison(time1) === normalizeTimeForComparison(time2);
}

function rawRowsToFallbackModels(rows: RawChiliSlotRow[]): ChiliSlotForFallback[] {
  const out: ChiliSlotForFallback[] = [];
  for (const raw of rows) {
    if (raw.disabled) continue;
    let minutes: number | null = null;
    if (raw.dataTestId.startsWith('slot-')) {
      minutes = parseMinutesFromChiliSlotTestId(raw.dataTestId);
    }
    if (minutes === null && raw.text) {
      minutes = parseWallTimeToMinutes(raw.text);
    }
    if (minutes === null) continue;
    const label =
      raw.text.trim() ||
      (() => {
        const h24 = Math.floor(minutes / 60);
        const min = minutes % 60;
        let h12 = h24 % 12;
        if (h12 === 0) h12 = 12;
        const ap = h24 >= 12 ? 'PM' : 'AM';
        return `${h12}:${String(min).padStart(2, '0')} ${ap}`;
      })();
    out.push({ label, minutes });
  }
  return out;
}

/**
 * Try to click the enabled slot matching `timeDisplay` (exact id + text strategies).
 * Returns true if a slot was clicked.
 */
export async function tryClickChiliSlotAtTime(
  calendarContext: { $: (sel: string) => Promise<unknown>; $$: (sel: string) => Promise<unknown[]> },
  timeDisplay: string
): Promise<boolean> {
  const formattedTime = formatTimeForChiliSlotId(timeDisplay);
  const slotTimeId = `slot-${formattedTime}`;
  const slotIdVariations = [
    slotTimeId,
    `slot-${timeDisplay.replace(/\s+/g, '')}`,
    `slot-${timeDisplay.replace(/\s+/g, '').toUpperCase()}`,
    `slot-${timeDisplay.replace(/\s+/g, '').toLowerCase()}`,
  ];

  for (const slotId of slotIdVariations) {
    try {
      const slotButton = (await calendarContext.$(`button[data-test-id="${slotId}"]`)) as {
        evaluate: (fn: (el: HTMLElement) => boolean) => Promise<boolean>;
        click: () => Promise<void>;
      } | null;
      if (slotButton) {
        const isDisabled = await slotButton.evaluate(
          (el) =>
            (el as HTMLButtonElement).disabled ||
            el.getAttribute('aria-disabled') === 'true'
        );
        if (!isDisabled) {
          await slotButton.click();
          return true;
        }
      }
    } catch {
      /* try next */
    }
  }

  const slotButtons = (await calendarContext.$$(
    '[data-id="calendar-slot"], button[data-test-id^="slot-"]'
  )) as Array<{
    textContent: () => Promise<string | null>;
    evaluate: (fn: (el: HTMLElement) => boolean) => Promise<boolean>;
    click: () => Promise<void>;
  }>;

  for (const button of slotButtons) {
    try {
      const buttonText = await button.textContent();
      if (!buttonText) continue;
      const isDisabled = await button.evaluate(
        (el) =>
          (el as HTMLButtonElement).disabled ||
          el.getAttribute('aria-disabled') === 'true'
      );
      if (isDisabled) continue;

      const trimmedText = buttonText.trim();
      const normalizedButtonTime = normalizeTimeForComparison(trimmedText);
      const normalizedTargetTime = normalizeTimeForComparison(timeDisplay);

      if (
        normalizedButtonTime === normalizedTargetTime ||
        trimmedText.toUpperCase() === timeDisplay.toUpperCase() ||
        trimmedText.toLowerCase() === timeDisplay.toLowerCase() ||
        timesMatchForChili(trimmedText, timeDisplay)
      ) {
        await button.click();
        return true;
      }
    } catch {
      /* continue */
    }
  }

  return false;
}

function displayLabelForBookedMinutes(minutes: number, buttonTextIfAny?: string): string {
  const fromText = buttonTextIfAny?.trim();
  if (fromText) {
    const p = parseWallTimeToMinutes(fromText);
    if (p === minutes) {
      const m = /^(\d{1,2}:\d{2})\s*(AM|PM)$/i.exec(fromText.replace(/\s+/g, ' '));
      if (m) return `${m[1]} ${m[2].toUpperCase()}`;
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
 * Exact match first, then ±window fallback. Returns canonical booked time label.
 * @throws ChiliSlotWindowExhaustedError when no slot in window could be clicked
 */
export async function pickChiliSlotWithFallback(
  calendarContext: {
    $$eval: (sel: string, fn: (buttons: Element[]) => RawChiliSlotRow[]) => Promise<RawChiliSlotRow[]>;
    $: (sel: string) => Promise<unknown>;
    $$: (sel: string) => Promise<unknown[]>;
  },
  requestedDate: string,
  requestedTime: string,
  windowMinutes: SlotFallbackWindowMinutes
): Promise<string> {
  const targetMinutes = parseWallTimeToMinutes(requestedTime);
  if (targetMinutes === null) {
    throw new Error(`Invalid time for slot fallback: ${requestedTime}`);
  }

  const raw = await collectRawChiliSlotRows(calendarContext);
  const models = rawRowsToFallbackModels(raw);
  const availableLabels = models.map((m) => m.label).slice(0, 60);

  if (await tryClickChiliSlotAtTime(calendarContext, requestedTime)) {
    return displayLabelForBookedMinutes(targetMinutes, requestedTime);
  }

  const orderedLabels = orderChiliSlotFallbackLabels(targetMinutes, windowMinutes, models);
  for (const label of orderedLabels) {
    if (await tryClickChiliSlotAtTime(calendarContext, label)) {
      const mins = parseWallTimeToMinutes(label);
      if (mins !== null) {
        return displayLabelForBookedMinutes(mins, label);
      }
      return label;
    }
  }

  throw new ChiliSlotWindowExhaustedError(
    requestedDate,
    requestedTime,
    windowMinutes,
    availableLabels
  );
}
