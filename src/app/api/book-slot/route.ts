import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecurityMiddleware } from '@/lib/security-middleware';
import { concurrencyManager } from '@/lib/concurrency-manager';
import { ErrorHandler, ErrorCode, SuccessCode } from '@/lib/error-handler';
import { browserInstanceManager } from '@/lib/browser-instance-manager';
import { ChiliPiperScraper } from '@/lib/scraper';
import { browserPool } from '@/lib/browser-pool';
import {
  CHILI_PIPER_VIDEO_DIR,
  CHILI_PIPER_VIDEO_ENABLED,
  saveChiliPiperFailureVideo,
} from '@/lib/chili-piper-video';
import { getChiliPiperVendorConfig, normalizeChiliPiperVendorId } from '@/lib/chili-piper-vendors';
import { bookLuxuryPresenceSlot } from '@/lib/luxury-presence-chili-booker';
import { resolveBookSlotDateTime } from '@/lib/book-slot-datetime';

const security = new SecurityMiddleware();

/** POST /api/book-slot JSON body after sanitization */
type BookSlotRequestBody = {
  email: string;
  dateTime?: string;
  date?: string;
  time?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  vendor?: string;
};

/**
 * Format time for slot button data-test-id
 * "1:25 PM" -> "1:25PM" (no space, uppercase AM/PM)
 */
function formatTimeForSlot(time: string): string {
  return time.replace(/\s+/g, '').toUpperCase();
}

/** True if YYYY-MM-DD is strictly before "today" in America/Chicago (booking calendars are forward-looking). */
function isYmdBeforeTodayInCentral(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const inputKey = y * 10000 + mo * 100 + d;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const ty = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const tm = Number(parts.find((p) => p.type === 'month')?.value ?? 0);
  const td = Number(parts.find((p) => p.type === 'day')?.value ?? 0);
  if (!ty || !tm || !td) return false;
  const todayKey = ty * 10000 + tm * 100 + td;
  return inputKey < todayKey;
}

/**
 * Build parameterized URL (helper function)
 */
function buildParameterizedUrl(
  firstName: string,
  lastName: string,
  email: string,
  phone: string,
  baseUrl: string,
  phoneFieldId: string
): string {
  const urlParts = new URL(baseUrl);
  const params = new URLSearchParams({
    PersonFirstName: firstName,
    PersonLastName: lastName,
    PersonEmail: email,
  });

  const phoneValue = phone.startsWith('+') ? phone.slice(1) : phone;
  params.append(phoneFieldId, phoneValue);

  const existingParams = new URLSearchParams(urlParts.search);
  for (const [key, value] of Array.from(params.entries())) {
    existingParams.set(key, value);
  }

  return `${urlParts.origin}${urlParts.pathname}?${existingParams.toString()}`;
}

interface CreateInstanceOptions {
  baseUrl?: string;
  directCalendar?: boolean;
}

/** Direct-calendar SPA (e.g. Luxury round-robin): longer nav/UI waits; poll for real mounted widgets. */
const DIRECT_CALENDAR_GOTO_TIMEOUT_MS = 30000;
const DIRECT_CALENDAR_UI_POLL_TOTAL_MS = 45000;

const CALENDAR_CHROME_SELECTOR =
  '[data-id="calendar-arrows-button-next"], [data-id="calendar-arrows-button-prev"], button[data-test-id^="days:"], [data-id="calendar-day-button"], [data-id="calendar-day-button-selected"]';

/**
 * Wait until Chili Piper calendar strip or week arrows appear (main document or iframes).
 * `document` load fires before React hydration; this targets visible booking UI.
 */
async function waitForCalendarChrome(page: any, totalTimeoutMs: number): Promise<'main' | 'iframe'> {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    const slice = Math.min(8000, Math.max(500, deadline - Date.now()));
    try {
      await page.waitForSelector(CALENDAR_CHROME_SELECTOR, { timeout: slice });
      return 'main';
    } catch {
      /* keep polling */
    }
    for (const frame of page.frames()) {
      const ft = Math.min(4000, Math.max(300, deadline - Date.now()));
      if (ft < 300) break;
      try {
        await frame.waitForSelector(CALENDAR_CHROME_SELECTOR, { timeout: ft });
        return 'iframe';
      } catch {
        /* next frame */
      }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(
    `Timeout ${totalTimeoutMs}ms waiting for Chili Piper calendar UI (arrows or day buttons)`
  );
}

interface CreateInstanceDiagOpts {
  sessionId: string;
  targetUrl: string;
  directCalendar: boolean;
  consoleWarnings: string[];
  consoleAndPageErrors: string[];
}

/** Log URL, title, HTML preview, frames, console errors — before closing the page on create failure. */
async function logCreateInstancePageDiagnostics(
  page: any,
  opts: CreateInstanceDiagOpts
): Promise<void> {
  const { sessionId, targetUrl, directCalendar, consoleWarnings, consoleAndPageErrors } = opts;
  console.error('[createInstance] Failure diagnostics', {
    sessionId,
    directCalendar,
    intendedUrl: targetUrl.length > 200 ? `${targetUrl.slice(0, 200)}…` : targetUrl,
  });
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    console.error('[createInstance] Page missing or already closed; skipping snapshot');
    return;
  }
  try {
    const url = typeof page.url === 'function' ? page.url() : '(no url())';
    const title = await page.title().catch(() => '(title() failed)');
    const content = await page.content().catch(() => '');
    const len = typeof content === 'string' ? content.length : 0;
    const preview = typeof content === 'string' ? content.slice(0, 2500) : '';
    console.error('[createInstance] Live page URL:', url);
    console.error('[createInstance] Page title:', title);
    console.error('[createInstance] document.documentElement outerHTML length:', len);
    if (preview) {
      console.error('[createInstance] HTML preview (first 2500 chars):\n', preview);
    }
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    console.error('[createInstance] Frame count:', frames.length);
    frames.slice(0, 15).forEach((f: any, i: number) => {
      try {
        const u = typeof f.url === 'function' ? f.url() : '(unknown)';
        console.error(`[createInstance] Frame[${i}]:`, u.length > 300 ? `${u.slice(0, 300)}…` : u);
      } catch {
        console.error(`[createInstance] Frame[${i}]: (could not read url)`);
      }
    });
  } catch (e) {
    console.error('[createInstance] Diagnostic read failed:', (e as Error)?.message);
  }
  if (consoleWarnings.length > 0) {
    console.error('[createInstance] Browser console warnings (recent):', consoleWarnings);
  }
  if (consoleAndPageErrors.length > 0) {
    console.error('[createInstance] Browser console errors + pageerror (recent):', consoleAndPageErrors);
  }
  try {
    const failedDir = path.join(CHILI_PIPER_VIDEO_DIR, 'failed');
    fs.mkdirSync(failedDir, { recursive: true });
    const shotPath = path.join(failedDir, `create-instance-debug-${sessionId}.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    console.error('[createInstance] Debug screenshot:', shotPath);
  } catch (shotErr) {
    console.warn('[createInstance] Debug screenshot failed:', (shotErr as Error)?.message);
  }
}

/**
 * Create a new browser instance and navigate to calendar for an email
 */
async function createInstanceForEmail(
  email: string,
  firstName: string,
  lastName: string,
  phone: string,
  options?: CreateInstanceOptions
): Promise<{ browser: any; context: any; page: any; videoDir?: string; sessionId?: string } | null> {
  let browser: any = null;
  let context: any = null;
  let page: any = null;
  let releaseLock: (() => void) | null = null;
  let videoDir: string | null = null;
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const baseUrl = options?.baseUrl ?? process.env.CHILI_PIPER_FORM_URL ?? "https://cincpro.chilipiper.com/concierge-router/link/lp-request-a-demo-agent-advice";
  const directCalendar = options?.directCalendar ?? false;
  const phoneFieldId = process.env.CHILI_PIPER_PHONE_FIELD_ID || 'aa1e0f82-816d-478f-bf04-64a447af86b3';
  const targetUrl = directCalendar
    ? baseUrl
    : buildParameterizedUrl(firstName, lastName, email, phone || '+15555555555', baseUrl, phoneFieldId);

  const t0 = Date.now();
  const logTiming = (step: string) => console.log(`[createInstance] ${step}: ${Date.now() - t0}ms`);
  const browserDiagWarnings: string[] = [];
  const browserDiagErrors: string[] = [];

  try {

    if (CHILI_PIPER_VIDEO_ENABLED) {
      const recordDir = path.join(os.tmpdir(), 'chili-piper-videos', sessionId);
      try {
        fs.mkdirSync(recordDir, { recursive: true });
        videoDir = recordDir;
        console.log(`[Chili Piper] Recording enabled: ${videoDir}`);
      } catch (e) {
        console.warn('[Chili Piper] Video disabled (mkdir failed):', (e as Error)?.message);
      }
    }

    browser = await browserPool.getBrowser();
    
    // Acquire lock for context creation to prevent race conditions
    releaseLock = await browserPool.acquireContextLock(browser);
    
    // Retry logic for browser context creation (handles race conditions)
    let retries = 3;
    while (retries > 0) {
      try {
        // Check browser connection before creating context
        if (!browser.isConnected()) {
          console.log('⚠️ Browser disconnected, getting new browser instance...');
          // Release lock and browser before getting new one
          if (releaseLock) releaseLock();
          browserPool.releaseBrowser(browser);
          browser = await browserPool.getBrowser();
          releaseLock = await browserPool.acquireContextLock(browser);
        }
        const contextOptions: {
          timezoneId: string;
          recordVideo?: { dir: string; size: { width: number; height: number } };
          userAgent?: string;
          locale?: string;
          viewport?: { width: number; height: number };
        } = {
          timezoneId: 'America/Chicago',
        };
        if (directCalendar) {
          contextOptions.userAgent =
            process.env.CHILI_PIPER_DESKTOP_UA ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
          contextOptions.locale = 'en-US';
          contextOptions.viewport = { width: 1280, height: 720 };
        }
        if (videoDir) contextOptions.recordVideo = { dir: videoDir, size: { width: 1280, height: 720 } };
        context = await browser.newContext(contextOptions);
        page = await context.newPage();
        break; // Success, exit retry loop
      } catch (error: any) {
        retries--;
        if (error.message && error.message.includes('has been closed') && retries > 0) {
          console.log(`⚠️ Browser/context closed, retrying... (${retries} attempts left)`);
          // Release lock and browser before getting new one
          if (releaseLock) releaseLock();
          browserPool.releaseBrowser(browser);
          browser = await browserPool.getBrowser();
          releaseLock = await browserPool.acquireContextLock(browser);
          // Small delay before retry
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          // Release lock and browser on error
          if (releaseLock) releaseLock();
          browserPool.releaseBrowser(browser);
          throw error; // Re-throw if not a "closed" error or no retries left
        }
      }
    }
    
    // Release lock after context is created
    if (releaseLock) {
      releaseLock();
      releaseLock = null;
    }
    
    if (!page) {
      browserPool.releaseBrowser(browser);
      throw new Error('Failed to create browser context after retries');
    }

    page.on('console', (msg: { type: () => string; text: () => string }) => {
      try {
        const t = msg.type();
        if (t !== 'error' && t !== 'warning') return;
        const line = `[console.${t}] ${msg.text()}`.slice(0, 800);
        const arr = t === 'error' ? browserDiagErrors : browserDiagWarnings;
        arr.push(line);
        if (arr.length > 25) arr.shift();
      } catch {
        /* ignore */
      }
    });
    page.on('pageerror', (err: Error) => {
      try {
        browserDiagErrors.push(`[pageerror] ${err.message}`.slice(0, 800));
        if (browserDiagErrors.length > 30) browserDiagErrors.shift();
      } catch {
        /* ignore */
      }
    });

    logTiming('context+page ready');

    const navTimeout = directCalendar ? DIRECT_CALENDAR_GOTO_TIMEOUT_MS : 15000;
    const defaultTimeout = directCalendar ? DIRECT_CALENDAR_UI_POLL_TOTAL_MS : 15000;
    page.setDefaultNavigationTimeout(navTimeout);
    page.setDefaultTimeout(defaultTimeout);

    if (directCalendar) {
      await page.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch {
          /* ignore */
        }
      });
    }

    // Direct-calendar: do not intercept requests — false positives (e.g. "analytics" in path) can block app bundles.
    if (!directCalendar) {
      await page.route("**/*", (route: any) => {
        const url = route.request().url();
        const rt = route.request().resourceType();
        const tracking =
          url.includes('google-analytics') ||
          url.includes('googletagmanager') ||
          url.includes('analytics') ||
          url.includes('facebook.net') ||
          url.includes('doubleclick') ||
          url.includes('ads') ||
          url.includes('tracking') ||
          url.includes('pixel') ||
          url.includes('beacon');
        if (tracking) {
          route.abort();
          return;
        }
        if (rt === 'image' || rt === 'font' || rt === 'media') {
          route.abort();
          return;
        }
        route.continue();
      });
    }

    await page.goto(targetUrl, {
      waitUntil: directCalendar ? 'domcontentloaded' : 'load',
      timeout: navTimeout,
    });
    logTiming('goto done');

    if (directCalendar) {
      const html = await page.content().catch(() => '');
      const tiny = html.length < 3000;
      const noScript = !/<script/i.test(html);
      if (tiny && noScript) {
        console.warn(
          '[createInstance] Direct-calendar: document has no scripts (likely bot shell); reloading with networkidle…'
        );
        try {
          await page.reload({
            waitUntil: 'networkidle',
            timeout: Math.min(45000, navTimeout + 15000),
          });
          logTiming('reload networkidle (empty shell recovery)');
        } catch (reloadErr) {
          console.warn('[createInstance] Empty-shell reload failed:', (reloadErr as Error)?.message);
        }
      }
    }

    const SUBMIT_MAX_MS = 10000;
    const SCHEDULE_MAX_MS = 10000;
    const CALENDAR_CHECK_AFTER_SUBMIT_MS = 5000;

    let calendarFound = false;
    let calendarStrategy: string = 'none';

    if (!directCalendar) {
      // Brief wait for form to be interactive
      await new Promise((r) => setTimeout(r, 1500));
      logTiming('after initial 1.5s wait');

      // Click submit button (max 10s total)
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Continue")',
        '[data-test-id="GuestForm-submit-button"]',
      ];
      const submitTimeoutPerSelector = Math.max(500, Math.floor(SUBMIT_MAX_MS / submitSelectors.length));
      let submitClicked = false;
      for (const selector of submitSelectors) {
        try {
          await page.click(selector, { timeout: submitTimeoutPerSelector });
          submitClicked = true;
          logTiming(`submit clicked (${selector.slice(0, 35)})`);
          break;
        } catch {}
      }
      if (!submitClicked) logTiming('submit: no selector matched');
      await new Promise((r) => setTimeout(r, 1500));

      // Look for calendar; if present, skip schedule button
      const quickCalendarSelectors = [
        '[data-id="calendar-day-button"]',
        'button[data-test-id^="days:"]',
        '[data-id="calendar"]',
        '[role="grid"]',
      ];
      const checkTimeoutPerSelector = Math.max(500, Math.floor(CALENDAR_CHECK_AFTER_SUBMIT_MS / quickCalendarSelectors.length));
      for (const selector of quickCalendarSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: checkTimeoutPerSelector });
          calendarFound = true;
          calendarStrategy = 'after submit (skipped schedule)';
          logTiming('calendar visible after submit, skipping schedule');
          break;
        } catch {}
      }
      if (!calendarFound) {
        const frames = page.frames();
        for (const frame of frames) {
          try {
            await frame.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"], [data-id="calendar"], [role="grid"]', { timeout: checkTimeoutPerSelector });
            calendarFound = true;
            calendarStrategy = 'after submit (iframe, skipped schedule)';
            logTiming('calendar visible in iframe after submit, skipping schedule');
            break;
          } catch {}
        }
      }

      if (!calendarFound) {
        // Calendar not present; click schedule button (max 10s total)
        const scheduleSelectors = [
          '[data-test-id="ConciergeLiveBox-book"]',
          '[data-id="concierge-live-book"]',
          'button:has-text("Schedule a meeting")',
          'button:has-text("Schedule")',
        ];
        const scheduleTimeoutPerSelector = Math.max(500, Math.floor(SCHEDULE_MAX_MS / scheduleSelectors.length));
        let scheduleClicked = false;
        for (const selector of scheduleSelectors) {
          try {
            await page.click(selector, { timeout: scheduleTimeoutPerSelector });
            scheduleClicked = true;
            logTiming(`schedule clicked (${selector.slice(0, 35)})`);
            break;
          } catch {}
        }
        if (!scheduleClicked) logTiming('schedule: no selector matched');

        await new Promise((r) => setTimeout(r, 2000));
        logTiming('after 2s post-schedule wait');
      }
    } else {
      // Round-robin SPA: `load` is unreliable; allow hydration then wait for mounted calendar chrome.
      await new Promise((r) => setTimeout(r, 2000));
      logTiming('after direct-calendar hydration wait');
      const where = await waitForCalendarChrome(page, DIRECT_CALENDAR_UI_POLL_TOTAL_MS);
      calendarFound = true;
      calendarStrategy = `direct-calendar:${where}`;
    }
    logTiming('form flow done');

    // Wait for calendar if not already found (e.g. after schedule click)
    if (!calendarFound) {
      const calendarSelectors = [
        '[data-id="calendar-day-button"]',
        'button[data-test-id^="days:"]',
        '[data-id="calendar-day-button-selected"]',
        '[data-id="calendar"]',
        '[role="grid"]',
        '[data-test-id*="calendar"]',
        'button[data-test-id*="days:"]',
      ];
      for (const selector of calendarSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          calendarFound = true;
          calendarStrategy = `main:${selector.slice(0, 40)}`;
          break;
        } catch {}
      }
      if (!calendarFound) {
        const frames = page.frames();
        for (const frame of frames) {
          try {
            await frame.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"], [data-id="calendar"], [role="grid"]', { timeout: 5000 });
            calendarFound = true;
            calendarStrategy = 'iframe';
            break;
          } catch {}
        }
      }
      if (!calendarFound) {
        await page.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"]', { timeout: 15000 });
        calendarStrategy = 'final wait (15s)';
      }
    }

    logTiming(`calendar visible (${calendarStrategy})`);

    const out: { browser: any; context: any; page: any; videoDir?: string; sessionId?: string } = { browser, context, page };
    if (videoDir) out.videoDir = videoDir;
    if (sessionId) out.sessionId = sessionId;
    logTiming('total (instance ready)');
    return out;
  } catch (error) {
    logTiming('failed');
    console.error('Error creating instance:', error);

    if (page && typeof page.isClosed === 'function' && !page.isClosed()) {
      await logCreateInstancePageDiagnostics(page, {
        sessionId,
        targetUrl,
        directCalendar,
        consoleWarnings: browserDiagWarnings,
        consoleAndPageErrors: browserDiagErrors,
      }).catch(() => {});
    }

    // Flush failure video via saveAs (context must stay open until saveAs completes)
    if (videoDir && sessionId && CHILI_PIPER_VIDEO_ENABLED && page) {
      try {
        const vid = typeof page.video === 'function' ? page.video() : null;
        if (!page.isClosed()) await page.close().catch(() => {});
        if (vid && typeof vid.saveAs === 'function') {
          const failedDir = path.join(CHILI_PIPER_VIDEO_DIR, 'failed');
          fs.mkdirSync(failedDir, { recursive: true });
          const destPath = path.join(failedDir, `chili-piper-${sessionId}.webm`);
          await vid.saveAs(destPath);
          console.log('[Chili Piper] Saved failure video (instance creation failed):', destPath);
        }
        page = null;
      } catch (saveErr) {
        console.warn('[Chili Piper] Could not save failure video on create error:', (saveErr as Error)?.message);
      }
    }

    // Clean up on error
    try {
      if (releaseLock) releaseLock();
      if (page && !page.isClosed()) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) browserPool.releaseBrowser(browser);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }

    return null;
  }
}

/**
 * Navigate an existing page (reused instance) to the calendar view.
 * Used when the page is not showing the calendar (stale tab, wrong user, SPA navigated).
 * When directCalendar is true, goes to baseUrl only and skips submit/schedule clicks.
 */
async function navigateExistingPageToCalendar(
  page: any,
  email: string,
  firstName: string,
  lastName: string,
  phone: string,
  log: (msg: string, data?: Record<string, unknown>) => void,
  options?: CreateInstanceOptions
): Promise<boolean> {
  try {
    const baseUrl = options?.baseUrl ?? process.env.CHILI_PIPER_FORM_URL ?? "https://cincpro.chilipiper.com/concierge-router/link/lp-request-a-demo-agent-advice";
    const directCalendar = options?.directCalendar ?? false;
    const phoneFieldId = process.env.CHILI_PIPER_PHONE_FIELD_ID || 'aa1e0f82-816d-478f-bf04-64a447af86b3';
    const targetUrl = directCalendar
      ? baseUrl
      : buildParameterizedUrl(firstName, lastName, email, phone || '+15555555555', baseUrl, phoneFieldId);

    log('Re-navigating existing instance to calendar', { url: targetUrl.slice(0, 80) + '...' });
    const navT = directCalendar ? DIRECT_CALENDAR_GOTO_TIMEOUT_MS : 15000;
    const defT = directCalendar ? DIRECT_CALENDAR_UI_POLL_TOTAL_MS : 15000;
    page.setDefaultNavigationTimeout(navT);
    page.setDefaultTimeout(defT);
    await page.goto(targetUrl, {
      waitUntil: directCalendar ? 'domcontentloaded' : 'load',
      timeout: navT,
    });

    if (directCalendar) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await waitForCalendarChrome(page, DIRECT_CALENDAR_UI_POLL_TOTAL_MS);
        log('Calendar visible after re-navigation (direct calendar)');
        return true;
      } catch (e) {
        log('Direct calendar UI wait failed after re-navigation', {
          error: (e as Error)?.message,
        });
        return false;
      }
    }

    await new Promise((r) => setTimeout(r, 1500));

    if (!directCalendar) {
      const submitSelectors = [
        'button[type="submit"]', 'input[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Continue")',
        '[data-test-id="GuestForm-submit-button"]',
      ];
      for (const selector of submitSelectors) {
        try {
          await page.click(selector, { timeout: 3000 });
          await new Promise((r) => setTimeout(r, 1500));
          break;
        } catch { /* ignore */ }
      }

      const scheduleSelectors = [
        '[data-test-id="ConciergeLiveBox-book"]', '[data-id="concierge-live-book"]',
        'button:has-text("Schedule a meeting")', 'button:has-text("Schedule")',
      ];
      for (const selector of scheduleSelectors) {
        try {
          await page.click(selector, { timeout: 3000 });
          break;
        } catch { /* ignore */ }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    try {
      await page.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"]', { timeout: 10000 });
      log('Calendar visible after re-navigation');
      return true;
    } catch {
      const frames = page.frames();
      for (const frame of frames) {
        try {
          await frame.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"]', { timeout: 5000 });
          log('Calendar visible in iframe after re-navigation');
          return true;
        } catch { /* continue */ }
      }
    }
    return false;
  } catch (e) {
    log('Re-navigation failed', { error: (e as Error)?.message });
    return false;
  }
}

export async function POST(request: NextRequest) {
  const requestStartTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Apply security middleware
    const securityResult = await security.secureRequest(request, {
      requireAuth: true,
      rateLimit: { maxRequests: 100, windowMs: 15 * 60 * 1000 }, // 100 requests per 15 minutes
      inputSchema: {
        email: { type: 'email', required: true, maxLength: 255 },
        dateTime: { type: 'string', required: false, maxLength: 500 },
        date: { type: 'string', required: false, maxLength: 12 },
        time: { type: 'string', required: false, maxLength: 32 },
        firstName: { type: 'string', required: false, maxLength: 155 },
        lastName: { type: 'string', required: false, maxLength: 155 },
        phone: { type: 'string', required: false, maxLength: 30 },
        vendor: { type: 'string', required: false, maxLength: 50 },
      },
      allowedMethods: ['POST'],
    });

    if (!securityResult.allowed) {
      const responseTime = Date.now() - requestStartTime;
      const errorResponse = ErrorHandler.createError(
        ErrorCode.UNAUTHORIZED,
        'Request blocked by security middleware',
        securityResult.response?.statusText || 'Authentication or validation failed',
        undefined,
        requestId,
        responseTime
      );
      const response = NextResponse.json(
        errorResponse,
        { status: ErrorHandler.getStatusCode(errorResponse.code) }
      );
      return security.addSecurityHeaders(response);
    }

    const body = securityResult.sanitizedData! as BookSlotRequestBody;
    const { email, dateTime, firstName, lastName, phone, vendor } = body;
    const hasDt = typeof dateTime === 'string' && dateTime.trim().length > 0;
    const hasSplit =
      typeof body.date === 'string' &&
      body.date.trim().length > 0 &&
      typeof body.time === 'string' &&
      body.time.trim().length > 0;
    if (!hasDt && !hasSplit) {
      const responseTime = Date.now() - requestStartTime;
      const errorResponse = ErrorHandler.createError(
        ErrorCode.VALIDATION_ERROR,
        'Missing date/time',
        'Provide dateTime (e.g. "November 13, 2025 at 1:25 PM CST") or both date (YYYY-MM-DD) and time (e.g. 1:25 PM)',
        undefined,
        requestId,
        responseTime
      );
      const response = NextResponse.json(
        errorResponse,
        { status: 400 }
      );
      return security.addSecurityHeaders(response);
    }

    const vendorConfig = getChiliPiperVendorConfig(vendor as string | undefined);
    console.log('[book-slot] API called', {
      email,
      dateTime,
      date: body.date,
      time: body.time,
      requestId,
      vendor: vendor || 'cinq',
    });

    const parsed = resolveBookSlotDateTime({
      dateTime,
      date: body.date,
      time: body.time,
    });
    if (!parsed) {
      console.warn('[book-slot] Parse failed', { requestId, dateTime, date: body.date, time: body.time });
      const responseTime = Date.now() - requestStartTime;
      const errorResponse = ErrorHandler.createError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid date/time format',
        hasDt
          ? 'dateTime must be like "November 13, 2025 at 1:25 PM CST"'
          : 'date must be YYYY-MM-DD and time must be like 1:25 PM',
        { providedValue: { dateTime, date: body.date, time: body.time } },
        requestId,
        responseTime
      );
      const response = NextResponse.json(
        errorResponse,
        { status: 400 }
      );
      return security.addSecurityHeaders(response);
    }

    const { date, time } = parsed;
    const formattedTime = formatTimeForSlot(time);

    const vendorKey = normalizeChiliPiperVendorId(vendor as string | undefined);
    if (vendorKey === 'luxury-presence' && isYmdBeforeTodayInCentral(date)) {
      const responseTime = Date.now() - requestStartTime;
      const errorResponse = ErrorHandler.createError(
        ErrorCode.VALIDATION_ERROR,
        'Date is in the past',
        `Booking date ${date} is before today (US Central). Use a future date; Chili Piper does not offer past days on this calendar.`,
        { date },
        requestId,
        responseTime
      );
      return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: 400 }));
    }

    // Test mode: If email contains "test", return success without actually booking
    if (email.toLowerCase().includes('test')) {
      console.log(`🧪 Test mode: Email contains "test", returning mock success response`);
      const responseTime = Date.now() - requestStartTime;
      const successResponse = ErrorHandler.createSuccess(
        SuccessCode.OPERATION_SUCCESS,
        {
          message: 'Slot booked successfully (TEST MODE - no actual booking performed)',
          date: date,
          time: time,
          testMode: true,
        },
        requestId,
        responseTime
      );

      const response = NextResponse.json(
        successResponse,
        { status: ErrorHandler.getSuccessStatusCode() }
      );
      return security.addSecurityHeaders(response);
    }

    // Run booking through concurrency manager
    const result = await concurrencyManager.execute(async (): Promise<
      { success: true; date: string; time: string } | { success: false; error: string; videoPath?: string }
    > => {
      const scraper = new ChiliPiperScraper(vendorConfig.formUrl);
      let instance: { browser: any; context: any; page: any; videoDir?: string; sessionId?: string } | null = null;
      let browser: any = null;
      let context: any = null;
      let page: any = null;
      let videoDir: string | undefined;
      let sessionId: string | undefined;

      const log = (msg: string, data?: Record<string, unknown>) => {
        console.log('[book-slot]', requestId, msg, data ?? '');
      };
      const logErr = (msg: string, data?: Record<string, unknown>) => {
        console.error('[book-slot]', requestId, msg, data ?? '');
      };

      try {
        log('Booking started', { email, date: parsed!.date, time: parsed!.time });

        instance = scraper.getExistingInstance(email);

        if (!instance) {
          log('No existing instance, creating new one', { email });
          if (!firstName || !lastName) {
            logErr('Missing required fields for new instance', { hasFirst: !!firstName, hasLast: !!lastName });
            throw new Error('firstName and lastName are required when creating a new instance');
          }
          if (!vendorConfig.directCalendar && !phone) {
            logErr('Phone required for this vendor', { vendor: vendorConfig });
            throw new Error('phone is required when creating a new instance for this vendor');
          }
          const newInstance = await createInstanceForEmail(email, firstName, lastName, phone || '', {
            baseUrl: vendorConfig.formUrl,
            directCalendar: vendorConfig.directCalendar,
          });
          if (!newInstance) {
            logErr('createInstanceForEmail returned null');
            throw new Error('Failed to create browser instance');
          }
          browser = newInstance.browser;
          context = newInstance.context;
          page = newInstance.page;
          videoDir = newInstance.videoDir;
          sessionId = newInstance.sessionId;
          log('New instance created and registered', { sessionId });
          await browserInstanceManager.registerInstance(email, browser, context, page, videoDir, sessionId);
        } else {
          browser = instance.browser;
          context = instance.context;
          page = instance.page;
          videoDir = instance.videoDir;
          sessionId = instance.sessionId;
          log('Using existing instance', { email, hasVideoRecording: !!(videoDir && sessionId) });
        }

        // Capture Chili Piper page errors and console for debugging 500s
        page.on('pageerror', (err: Error) => {
          logErr('Chili Piper page JS error', { message: err.message, stack: err.stack });
        });
        page.on('console', (msg: { type: () => string; text: () => string }) => {
          const type = msg.type();
          const text = msg.text();
          if (type === 'error' || type === 'warning') {
            log('Chili Piper console', { type, text: text.slice(0, 500) });
          }
        });

        // Verify page is still valid
        if (page.isClosed()) {
          logErr('Page was already closed before booking');
          throw new Error('Browser page was closed');
        }

        // Resolve calendar context: main page or iframe (Chili Piper often embeds calendar in iframe)
        let calendarContext: any = page;
        let calendarFound = false;
        try {
          await page.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"]', { timeout: 5000 });
          calendarFound = true;
          log('Calendar view found on main page');
        } catch {
          // Try iframes
          const frames = page.frames();
          for (const frame of frames) {
            try {
              await frame.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"]', { timeout: 5000 });
              calendarContext = frame;
              calendarFound = true;
              log('Calendar view found in iframe');
              break;
            } catch {
              continue;
            }
          }
        }
        if (!calendarFound && instance && firstName && lastName && (phone || vendorConfig.directCalendar)) {
          // Same instance but calendar not visible. Clean up and run full form fill again (new browser, goto, submit, schedule, wait for calendar).
          let pageUrl = '';
          try {
            pageUrl = page.url();
          } catch {}
          log('Calendar not found on current page, cleaning up and starting full form fill again', { pageUrl: pageUrl || '(unknown)' });
          await browserInstanceManager.cleanupInstance(email);
          const newInstance = await createInstanceForEmail(email, firstName, lastName, phone || '', {
            baseUrl: vendorConfig.formUrl,
            directCalendar: vendorConfig.directCalendar,
          });
          if (newInstance) {
            browser = newInstance.browser;
            context = newInstance.context;
            page = newInstance.page;
            videoDir = newInstance.videoDir;
            sessionId = newInstance.sessionId;
            await browserInstanceManager.registerInstance(email, browser, context, page, videoDir, sessionId);
            log('New instance created after full form fill');
            page.on('pageerror', (err: Error) => {
              logErr('Chili Piper page JS error', { message: err.message, stack: err.stack });
            });
            page.on('console', (msg: { type: () => string; text: () => string }) => {
              const type = msg.type();
              const text = msg.text();
              if (type === 'error' || type === 'warning') {
                log('Chili Piper console', { type, text: text.slice(0, 500) });
              }
            });
            try {
              await page.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"]', { timeout: 5000 });
              calendarFound = true;
              calendarContext = page;
            } catch {
              const frames = page.frames();
              for (const frame of frames) {
                try {
                  await frame.waitForSelector('[data-id="calendar-day-button"], button[data-test-id^="days:"]', { timeout: 5000 });
                  calendarContext = frame;
                  calendarFound = true;
                  break;
                } catch {
                  /* continue */
                }
              }
            }
          }
        }
        if (!calendarFound) {
          let pageUrl = '';
          try {
            pageUrl = page.url();
          } catch {}
          logErr('Calendar not found on page or in iframes', {
            pageUrl: pageUrl || '(unknown)',
            hasInstance: !!instance,
            hasFirstLastPhone: !!(firstName && lastName && phone),
            frameCount: page.frames?.()?.length ?? 0,
          });
          throw new Error('Calendar not found on page');
        }

        const vendorKey = normalizeChiliPiperVendorId(vendor as string | undefined);
        if (vendorKey === 'luxury-presence') {
          if (!firstName || !lastName) {
            throw new Error('firstName and lastName are required for Luxury Presence booking');
          }
          await bookLuxuryPresenceSlot(calendarContext, page, {
            date,
            time,
            firstName,
            lastName,
            email,
            log,
            logErr,
          });
          log('Booking step completed, cleaning up instance', { email });
          await browserInstanceManager.cleanupInstance(email);
          return { success: true, date, time };
        }

        // Find and click the day button (use calendar context: page or iframe)
        const dayButtons = await calendarContext.$$('[data-id="calendar-day-button"], button[data-test-id^="days:"]');
        let dayClicked = false;
        log('Day button search', { targetDate: date, buttonCount: dayButtons.length });
        
      for (const button of dayButtons) {
        try {
          const buttonText = await button.textContent();
          if (!buttonText) continue;
          
          // Check if this button matches our target date
          // Button text format: "Monday 13th November Mon13Nov" or similar
          const dateMatch = buttonText.match(/(\d{1,2})(?:st|nd|rd|th)/i);
          if (!dateMatch) continue;
          
          const day = parseInt(dateMatch[1], 10);
          const targetDay = parseInt(date.split('-')[2], 10);
          
          // Also check month
          const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                             'july', 'august', 'september', 'october', 'november', 'december'];
          const targetMonth = parseInt(date.split('-')[1], 10);
          const targetMonthName = monthNames[targetMonth - 1];
          
          const buttonTextLower = buttonText.toLowerCase();
          const hasTargetMonth = buttonTextLower.includes(targetMonthName) || 
                                buttonTextLower.includes(targetMonthName.substring(0, 3));
          
          if (day === targetDay && hasTargetMonth) {
            await button.click();
            dayClicked = true;
            log('Clicked day button', { date });
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!dayClicked) {
        const dayButtonTexts: string[] = [];
        for (const btn of dayButtons) {
          try {
            const t = await btn.textContent();
            if (t) dayButtonTexts.push(t.trim().slice(0, 80));
          } catch {}
        }
        logErr('Day button not found', { targetDate: date, seenButtonTexts: dayButtonTexts });
        throw new Error(`Day button not found for date ${date}`);
      }

      // Wait for slots to load - use reliable wait condition (calendar context: page or iframe)
      try {
        await calendarContext.waitForSelector('[data-id="calendar-slot"], button[data-test-id^="slot-"]', { timeout: 5000 });
        log('Slot buttons appeared after day click');
      } catch (slotWaitErr) {
        // If slots don't appear, wait a bit more and try again
        await page.waitForTimeout(1000);
        const slotsExist = await calendarContext.$('[data-id="calendar-slot"], button[data-test-id^="slot-"]');
        if (!slotsExist) {
          logErr('No slot buttons found after clicking day', { date, error: (slotWaitErr as Error).message });
          throw new Error(`No slot buttons found after clicking day button for ${date}`);
        }
        log('Slot buttons appeared after extra wait');
      }

      // Log available slots for debugging
      try {
        const availableSlots = await calendarContext.$$eval('[data-id="calendar-slot"], button[data-test-id^="slot-"]', 
          (buttons: Element[]) => buttons.map((b: Element) => ({
            text: b.textContent?.trim() || '',
            dataTestId: b.getAttribute('data-test-id') || '',
            disabled: b.hasAttribute('disabled') || (b as HTMLButtonElement).disabled,
            ariaDisabled: b.getAttribute('aria-disabled') === 'true'
          }))
        );
        log('Available slots', {
          count: availableSlots.length,
          targetTime: time,
          formattedSlotId: `slot-${formattedTime}`,
          slots: availableSlots.map((s: { text: string; dataTestId: string; disabled: boolean; ariaDisabled: boolean }) =>
            `${s.text}|${s.dataTestId}|disabled=${s.disabled}`).slice(0, 20)
        });
      } catch (slotLogErr) {
        log('Could not log available slots', { error: (slotLogErr as Error).message });
      }

      // Find and click the time slot button
      const slotTimeId = `slot-${formattedTime}`;
      let slotClicked = false;
      
      // Helper function to normalize time for comparison
      const normalizeTime = (timeStr: string): string => {
        return timeStr.trim()
          .replace(/\s+/g, '') // Remove all spaces
          .toUpperCase()
          .replace(/^0+/, ''); // Remove leading zeros (e.g., "09:30" -> "9:30")
      };

      // Helper function to check if times match
      const timesMatch = (time1: string, time2: string): boolean => {
        const norm1 = normalizeTime(time1);
        const norm2 = normalizeTime(time2);
        return norm1 === norm2;
      };
      
      // Try exact data-test-id match first (with variations)
      const slotIdVariations = [
        slotTimeId, // "slot-5:00PM"
        `slot-${time.replace(/\s+/g, '')}`, // "slot-5:00 PM" -> "slot-5:00PM"
        `slot-${time.replace(/\s+/g, '').toUpperCase()}`, // "slot-5:00PM" (already uppercase)
        `slot-${time.replace(/\s+/g, '').toLowerCase()}`, // "slot-5:00pm"
      ];
      
      for (const slotId of slotIdVariations) {
        try {
          const slotButton = await calendarContext.$(`button[data-test-id="${slotId}"]`);
          if (slotButton) {
            const isDisabled = await slotButton.evaluate((el: any) => 
              el.disabled || el.getAttribute('aria-disabled') === 'true'
            );
            if (!isDisabled) {
              await slotButton.click();
              slotClicked = true;
              log('Clicked time slot by data-test-id', { slotId });
              break;
            } else {
              log('Slot button found but disabled', { slotId });
            }
          }
        } catch (error) {
          continue;
        }
      }

      // Fallback: try by text content with improved matching
      if (!slotClicked) {
        const slotButtons = await calendarContext.$$('[data-id="calendar-slot"], button[data-test-id^="slot-"]');
        log('Trying text matching for slot', { slotButtonCount: slotButtons.length, targetTime: time });
        
        for (const button of slotButtons) {
          try {
            const buttonText = await button.textContent();
            if (!buttonText) continue;
            
            // Check if button is disabled
            const isDisabled = await button.evaluate((el: any) => 
              el.disabled || el.getAttribute('aria-disabled') === 'true'
            );
            if (isDisabled) {
              continue;
            }
            
            // Try multiple matching strategies
            const trimmedText = buttonText.trim();
            const normalizedButtonTime = normalizeTime(trimmedText);
            const normalizedTargetTime = normalizeTime(time);
            
            // Match strategies:
            // 1. Exact normalized match (e.g., "5:00PM" === "5:00PM")
            // 2. Original text match (e.g., "5:00 PM" === "5:00 PM")
            // 3. Case-insensitive match
            if (normalizedButtonTime === normalizedTargetTime || 
                trimmedText.toUpperCase() === time.toUpperCase() ||
                trimmedText.toLowerCase() === time.toLowerCase() ||
                timesMatch(trimmedText, time)) {
              await button.click();
              slotClicked = true;
              log('Clicked time slot by text', { trimmedText, matchedTime: time });
              break;
            }
          } catch (error) {
            continue;
          }
        }
      }

      if (!slotClicked) {
        // Get available slots one more time for error message
        let availableSlotInfo = '';
        try {
          const slots = await calendarContext.$$eval('[data-id="calendar-slot"], button[data-test-id^="slot-"]', 
            (buttons: Element[]) => buttons.map((b: Element) => b.textContent?.trim()).filter(Boolean) as string[]
          );
          availableSlotInfo = ` Available slots: ${slots.join(', ')}`;
          logErr('Time slot button not found', { targetTime: time, slotTimeId, availableSlots: slots.slice(0, 30) });
        } catch {}
        
        throw new Error(`Time slot button not found for time ${time} (formatted: ${slotTimeId}).${availableSlotInfo}`);
      }

      // Wait a moment for slot selection to be processed
      await page.waitForTimeout(1000);

      // Vendors like luxury-presence show guest form after slot selection; fill and click Confirm Meeting
      if (vendorConfig.fillGuestFormAfterSlot && firstName && lastName && email) {
        const formContext = calendarContext as any;
        try {
          await formContext.waitForSelector('[data-test-id="GuestFormField-PersonFirstName"], [data-test-id="GuestForm-submit-button"]', { timeout: 5000 });
          const firstSel = '[data-test-id="GuestFormField-PersonFirstName"]';
          const lastSel = '[data-test-id="GuestFormField-PersonLastName"]';
          const emailSel = '[data-test-id="GuestFormField-PersonEmail"]';
          await formContext.fill(firstSel, firstName);
          await formContext.fill(lastSel, lastName);
          await formContext.fill(emailSel, email);
          const confirmSelectors = [
            '[data-test-id="GuestForm-submit-button"]',
            '[data-id="form-confirm-button"]',
            'button:has-text("Confirm Meeting")',
          ];
          for (const sel of confirmSelectors) {
            try {
              await formContext.click(sel, { timeout: 2000 });
              log('Clicked Confirm Meeting');
              break;
            } catch { /* try next */ }
          }
          await page.waitForTimeout(1500);
        } catch (formErr) {
          logErr('Guest form fill or confirm failed', { error: (formErr as Error)?.message });
          throw formErr;
        }
      }

        log('Booking step completed, cleaning up instance', { email });
        // Close instance after successful booking
        await browserInstanceManager.cleanupInstance(email);

        return { success: true, date, time };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        logErr('Booking failed inside execute', { error: message, stack: stack?.slice(0, 800) });
        let videoPath: string | undefined;
        if (videoDir && sessionId && context && page) {
          const saved = await saveChiliPiperFailureVideo(context, page, videoDir, sessionId);
          if (saved) videoPath = saved;
          log('Failure video saved', { videoPath: saved });
        }
        await browserInstanceManager.cleanupInstance(email);
        return { success: false, error: message, videoPath };
      }
    }, 30000); // 30 second timeout for booking

    if (!result.success) {
      const responseTime = Date.now() - requestStartTime;
      console.error('[book-slot] Returning 500 – booking failed', {
        requestId,
        error: result.error,
        videoPath: result.videoPath,
        responseTimeMs: responseTime,
      });
      const errorResponse = ErrorHandler.createError(
        ErrorCode.SCRAPING_FAILED,
        'Booking failed',
        result.error,
        { videoPath: result.videoPath },
        requestId,
        responseTime
      );
      const response = NextResponse.json(errorResponse, { status: 500 });
      return security.addSecurityHeaders(response);
    }

    const responseTime = Date.now() - requestStartTime;
    const successResponse = ErrorHandler.createSuccess(
      SuccessCode.OPERATION_SUCCESS,
      {
        message: 'Slot booked successfully',
        date: result.date,
        time: result.time,
      },
      requestId,
      responseTime
    );

    const response = NextResponse.json(
      successResponse,
      { status: ErrorHandler.getSuccessStatusCode() }
    );
    return security.addSecurityHeaders(response);

  } catch (error: any) {
    console.error('[book-slot] Top-level error', requestId, {
      message: error?.message,
      name: error?.name,
      stack: error?.stack?.slice(0, 600),
    });

    const responseTime = Date.now() - requestStartTime;

    // Handle queue timeout errors
    if (error.message && error.message.includes('timeout')) {
      const errorResponse = ErrorHandler.createError(
        ErrorCode.REQUEST_TIMEOUT,
        'Booking timed out',
        'Request timed out while waiting in queue or during execution. Please try again.',
        { queueStatus: concurrencyManager.getStatus(), originalError: error.message },
        requestId,
        responseTime
      );
      const response = NextResponse.json(
        errorResponse,
        { status: 504 }
      );
      return security.addSecurityHeaders(response);
    }

    // Handle queue full errors
    if (error.message && error.message.includes('queue is full')) {
      const errorResponse = ErrorHandler.createError(
        ErrorCode.QUEUE_FULL,
        'Request queue is full',
        'The system is currently processing too many requests. Please try again later.',
        { queueStatus: concurrencyManager.getStatus(), originalError: error.message },
        requestId,
        responseTime
      );
      const response = NextResponse.json(
        errorResponse,
        { status: 503 }
      );
      return security.addSecurityHeaders(response);
    }

    // Handle slot not found errors
    if (error.message && (error.message.includes('Time slot button not found') || error.message.includes('Time slot not found'))) {
      const errorResponse = ErrorHandler.createError(
        ErrorCode.SLOT_NOT_FOUND,
        'Time slot not found',
        'The requested time slot could not be found on the calendar. The slot may have been booked by another user, or the time format may not match.',
        { originalError: error.message },
        requestId,
        responseTime
      );
      const response = NextResponse.json(
        errorResponse,
        { status: 500 }
      );
      return security.addSecurityHeaders(response);
    }

    // Handle day button not found errors
    if (error.message && (error.message.includes('Day button not found') || error.message.includes('day button not found'))) {
      const errorResponse = ErrorHandler.createError(
        ErrorCode.DAY_BUTTON_NOT_FOUND,
        'Day button not found',
        'The requested date could not be found on the calendar. The date may be outside the available range or the calendar may not have loaded correctly.',
        { originalError: error.message },
        requestId,
        responseTime
      );
      const response = NextResponse.json(
        errorResponse,
        { status: 500 }
      );
      return security.addSecurityHeaders(response);
    }

    // Generic error
    const errorResponse = ErrorHandler.parseError(error, requestId, responseTime);
    const response = NextResponse.json(
      errorResponse,
      { status: ErrorHandler.getStatusCode(errorResponse.code) }
    );

    return security.addSecurityHeaders(response);
  }
}

export async function OPTIONS(request: NextRequest) {
  const response = new NextResponse(null, { status: 200 });
  return security.configureCORS(response);
}

