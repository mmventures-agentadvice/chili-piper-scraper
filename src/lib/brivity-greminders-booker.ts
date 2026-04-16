import type { Browser, Page } from 'playwright';
import { browserPool } from '@/lib/browser-pool';

const LOG_PREFIX = '[brivity-greminders]';

/** Match Calendly booker — reduces automation flags on third-party schedulers. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const GOTO_TIMEOUT_MS = 45_000;
const AFTER_CLICK_NAV_TIMEOUT_MS = 90_000;
const CONFIRM_TEXT_TIMEOUT_MS = 45_000;

export interface BrivityGremindersUrlParams {
  baseUrl: string;
  lo: string;
  unixSecondsD: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  meetingMinutes?: number;
  timezone?: string;
  teamSizeTier?: string;
}

export interface BrivityGremindersEnvConfig {
  baseUrl: string;
  lo: string;
  meetingMinutes: number;
  timezone: string;
  teamSizeTier: string;
}

/**
 * Read GReminders booking config from env. Returns null if required vars are missing.
 */
export function resolveBrivityGremindersConfigFromEnv(): BrivityGremindersEnvConfig | null {
  const baseUrl = process.env.BRIVITY_GREMINDERS_BASE_URL?.trim();
  const lo = process.env.BRIVITY_GREMINDERS_LO?.trim();
  if (!baseUrl || !lo) return null;

  const meetingMinutes = Math.max(1, parseInt(process.env.BRIVITY_MEETING_MINUTES || '30', 10) || 30);
  const timezone = process.env.BRIVITY_TIMEZONE?.trim() || 'America/Chicago';
  const teamSizeTier = process.env.BRIVITY_TEAM_SIZE_TIER?.trim() || 'N/A';

  return { baseUrl, lo, meetingMinutes, timezone, teamSizeTier };
}

function phoneDigitsOnly(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Build full GReminders booking URL (query string matches manual booking links).
 */
export function buildBrivityGremindersUrl(p: BrivityGremindersUrlParams): string {
  const m = p.meetingMinutes ?? 30;
  const timezone = p.timezone ?? 'America/Chicago';
  const cTeam = p.teamSizeTier ?? 'N/A';
  const u = new URL(p.baseUrl);
  u.searchParams.set('d', String(p.unixSecondsD));
  u.searchParams.set('m', String(m));
  u.searchParams.set('timezone', timezone);
  u.searchParams.set('lo', p.lo);
  u.searchParams.set('first_name', p.firstName);
  u.searchParams.set('last_name', p.lastName);
  u.searchParams.set('email', p.email);
  u.searchParams.set('phone', phoneDigitsOnly(p.phone));
  u.searchParams.set('c_team_size_tier', cTeam);
  return u.toString();
}

function installLightAdBlock(page: Page): Promise<void> {
  return page.route('**/*', (route) => {
    const url = route.request().url();
    if (
      url.includes('google-analytics') ||
      url.includes('googletagmanager') ||
      url.includes('facebook.net') ||
      url.includes('doubleclick') ||
      url.includes('/ads/') ||
      url.includes('tracking') ||
      url.includes('pixel') ||
      url.includes('beacon')
    ) {
      return route.abort();
    }
    return route.continue();
  });
}

async function clickScheduleAndWaitForBooked(page: Page): Promise<void> {
  const schedule = page
    .locator('button[type="submit"].btn-primary')
    .filter({ hasText: /^Schedule$/i })
    .first();
  const alt = page.getByRole('button', { name: /^Schedule$/i }).first();

  const clickPromise = schedule
    .waitFor({ state: 'visible', timeout: 25_000 })
    .then(() => schedule.click())
    .catch(async () => {
      await alt.waitFor({ state: 'visible', timeout: 15_000 });
      await alt.click();
    });

  await Promise.all([
    page.waitForURL(/\/booked\//, { timeout: AFTER_CLICK_NAV_TIMEOUT_MS }),
    clickPromise,
  ]);
}

async function assertConfirmation(page: Page): Promise<void> {
  try {
    await page.locator('#si-loader').waitFor({ state: 'hidden', timeout: 30_000 });
  } catch {
    /* spinner may already be gone or not present */
  }

  const notFound = await page.getByText(/could not be found|page you are looking for could not be found/i).first().isVisible().catch(() => false);
  if (notFound) {
    throw new Error('GReminders returned a not-found or disabled page');
  }

  const confirmedText = page.getByText(/You are confirmed/i).first();
  const greenCheck = page.locator('.fa-check-circle.green').first();

  await Promise.race([
    confirmedText.waitFor({ state: 'visible', timeout: CONFIRM_TEXT_TIMEOUT_MS }),
    greenCheck.waitFor({ state: 'visible', timeout: CONFIRM_TEXT_TIMEOUT_MS }),
  ]);
}

/**
 * Open the booking URL, submit Schedule, wait for /booked/ and confirmation UI.
 */
export async function bookBrivityViaGreminders(bookingUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let browser: unknown = null;
  let releaseLock: (() => void) | null = null;
  let context: { close: () => Promise<void> } | null = null;
  let page: Page | null = null;

  try {
    console.log(`${LOG_PREFIX} start`, { urlHost: (() => { try { return new URL(bookingUrl).host; } catch { return '(bad url)'; } })() });

    browser = await browserPool.getBrowser();
    releaseLock = await browserPool.acquireContextLock(browser);

    const ctx = await (browser as Browser).newContext({
      timezoneId: 'America/Chicago',
      locale: 'en-US',
      userAgent: BROWSER_USER_AGENT,
      viewport: { width: 1280, height: 720 },
    });
    context = ctx;
    page = await ctx.newPage();
    page.setDefaultNavigationTimeout(GOTO_TIMEOUT_MS);
    page.setDefaultTimeout(30_000);

    if (releaseLock) {
      releaseLock();
      releaseLock = null;
    }

    await installLightAdBlock(page);

    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    const landed = page.url();
    console.log(`${LOG_PREFIX} loaded`, { url: landed });

    const notFoundEarly = await page.getByText(/could not be found|page you are looking for could not be found/i).first().isVisible().catch(() => false);
    if (notFoundEarly) {
      return { ok: false, error: 'Booking page not found or scheduling link disabled' };
    }

    await clickScheduleAndWaitForBooked(page);

    const finalUrl = page.url();
    console.log(`${LOG_PREFIX} after submit`, { url: finalUrl });

    if (!/\/booked\//.test(finalUrl)) {
      return { ok: false, error: `Expected /booked/ URL after Schedule, got: ${finalUrl}` };
    }

    await assertConfirmation(page);
    console.log(`${LOG_PREFIX} confirmation OK`);

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let hint = '';
    try {
      if (page && !page.isClosed()) {
        const excerpt = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? '').catch(() => '');
        if (excerpt) hint = ` Page excerpt: ${excerpt.replace(/\s+/g, ' ').slice(0, 300)}`;
        console.log(`${LOG_PREFIX} failure`, { url: page.url(), hint: excerpt.slice(0, 200) });
      }
    } catch {
      /* ignore */
    }
    return { ok: false, error: `${msg}${hint}` };
  } finally {
    try {
      if (page && !page.isClosed()) await page.close();
    } catch {
      /* ignore */
    }
    try {
      if (context) await context.close();
    } catch {
      /* ignore */
    }
    if (releaseLock) releaseLock();
    if (browser) browserPool.releaseBrowser(browser);
  }
}
