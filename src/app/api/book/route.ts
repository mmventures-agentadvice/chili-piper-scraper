import { NextRequest, NextResponse } from 'next/server';
import { normalizeChiliPiperVendorId } from '@/lib/chili-piper-vendors';
import { SecurityMiddleware } from '@/lib/security-middleware';
import { concurrencyManager } from '@/lib/concurrency-manager';
import { ErrorHandler, ErrorCode, SuccessCode } from '@/lib/error-handler';
import { bookCalendlySlot, getDirectPaypercloseCalendlyUrl, normalizeTimeForCalendly } from '@/lib/calendly-booker';
import { bookLoftySlot, bookLoftySlotL2 } from '@/lib/lofty-booker';
import { POST as bookSlotPost } from '@/app/api/book-slot/route';
import { resolveBookSlotDateTime } from '@/lib/book-slot-datetime';
import { unixSecondsInCentral } from '@/lib/central-datetime-unix';

const BOOK_HOUSEJET_PPC_URL =
  process.env.BOOK_HOUSEJET_PPC_URL || 'https://xggz-mymh-hmop.n7c.xano.io/api:oLrvDV0I/book-housejet-ppc';

const BOOK_BRIVITY_URL =
  process.env.BOOK_BRIVITY_URL || 'https://xggz-mymh-hmop.n7c.xano.io/api:oLrvDV0I/book_brivity';

const security = new SecurityMiddleware();

/** Status codes for Zapier pathing: success=200, failure=201 */
const STATUS_SUCCESS = 200;
const STATUS_FAILURE = 201;

const VENDORS = [
  'cinq',
  'luxury-presence',
  'agentfire',
  'housejet-ppc',
  'brivity',
  'lofty',
  'lofty-5-9',
  'lofty-10-24',
  'lofty-25',
] as const;
type Vendor = (typeof VENDORS)[number];

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** E.164 US-style: +1 plus digits; avoids double +1 when input already includes country code. */
function toFullPhoneUs(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+1${digits}`;
}

/** Chili Piper via book-slot: send either `dateTime` or both `date` (YYYY-MM-DD) and `time` (e.g. 1:25 PM). If both are sent, `dateTime` wins. */
function buildBookSlotChiliBody(
  base: { email: string; firstName: string; lastName: string; phone: string },
  body: Record<string, unknown>,
  vendor?: string
): { ok: true; payload: Record<string, string> } | { ok: false; message: string } {
  const dateTime = body.dateTime as string | undefined;
  const date = body.date as string | undefined;
  const time = body.time as string | undefined;
  const hasDt = dateTime && typeof dateTime === 'string' && dateTime.trim().length > 0;
  const hasSplit =
    date &&
    typeof date === 'string' &&
    date.trim().length > 0 &&
    time &&
    typeof time === 'string' &&
    time.trim().length > 0;
  if (!hasDt && !hasSplit) {
    return {
      ok: false,
      message:
        'Provide dateTime (e.g. "November 13, 2025 at 1:25 PM CST") or both date (YYYY-MM-DD) and time (e.g. 1:25 PM)',
    };
  }
  const payload: Record<string, string> = {
    email: base.email,
    firstName: base.firstName,
    lastName: base.lastName,
    phone: base.phone,
  };
  if (vendor) payload.vendor = vendor;
  if (hasDt) {
    payload.dateTime = dateTime!.trim();
  } else {
    payload.date = date!.trim();
    payload.time = time!.trim();
  }
  return { ok: true, payload };
}

export async function POST(request: NextRequest) {
  const requestStartTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const securityResult = await security.secureRequest(request, {
      requireAuth: true,
      rateLimit: { maxRequests: 100, windowMs: 15 * 60 * 1000 },
      inputSchema: {
        vendor: { type: 'string', required: true },
        email: { type: 'email', required: true, maxLength: 255 },
        firstName: { type: 'string', required: true, minLength: 1, maxLength: 155 },
        lastName: { type: 'string', required: true, minLength: 1, maxLength: 155 },
        phone: { type: 'string', required: false, maxLength: 30 },
        dateTime: { type: 'string', required: false },
        date: { type: 'string', required: false },
        time: { type: 'string', required: false },
        answers: { type: 'object', required: false },
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
      return security.addSecurityHeaders(
        NextResponse.json(errorResponse, { status: STATUS_FAILURE })
      );
    }

    const body = securityResult.sanitizedData! as Record<string, unknown>;
    const vendor = normalizeChiliPiperVendorId(body.vendor as string | undefined);

    if (!VENDORS.includes(vendor as Vendor)) {
      const responseTime = Date.now() - requestStartTime;
      const errorResponse = ErrorHandler.createError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid vendor',
        `vendor must be one of: ${VENDORS.join(', ')}`,
        { providedValue: body.vendor },
        requestId,
        responseTime
      );
      return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
    }

    const email = body.email as string;
    const firstName = body.firstName as string;
    const lastName = body.lastName as string;
    const phone = (body.phone as string) || undefined;

    if (vendor === 'cinq') {
      const chili = buildBookSlotChiliBody(
        { email, firstName, lastName, phone: phone || '' },
        body
      );
      if (!chili.ok) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Missing date/time',
          `${chili.message} (vendor cinq)`,
          undefined,
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      const bookSlotUrl = request.nextUrl.origin + '/api/book-slot';
      const bookSlotRequest = new NextRequest(bookSlotUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': request.headers.get('Authorization') || '',
          'x-forwarded-for': request.headers.get('x-forwarded-for') || '',
          'x-real-ip': request.headers.get('x-real-ip') || '',
        },
        body: JSON.stringify(chili.payload),
      });
      const bookSlotResponse = await bookSlotPost(bookSlotRequest);
      const status = bookSlotResponse.status >= 200 && bookSlotResponse.status < 300 ? STATUS_SUCCESS : STATUS_FAILURE;
      const json = await bookSlotResponse.json();
      return security.addSecurityHeaders(NextResponse.json(json, { status }));
    }

    if (vendor === 'luxury-presence') {
      const chili = buildBookSlotChiliBody(
        { email, firstName, lastName, phone: phone || '' },
        body,
        'luxury-presence'
      );
      if (!chili.ok) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Missing date/time',
          `${chili.message} (vendor luxury-presence)`,
          undefined,
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      const bookSlotUrl = request.nextUrl.origin + '/api/book-slot';
      const bookSlotRequest = new NextRequest(bookSlotUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': request.headers.get('Authorization') || '',
          'x-forwarded-for': request.headers.get('x-forwarded-for') || '',
          'x-real-ip': request.headers.get('x-real-ip') || '',
        },
        body: JSON.stringify(chili.payload),
      });
      const bookSlotResponse = await bookSlotPost(bookSlotRequest);
      const status = bookSlotResponse.status >= 200 && bookSlotResponse.status < 300 ? STATUS_SUCCESS : STATUS_FAILURE;
      const json = await bookSlotResponse.json();
      return security.addSecurityHeaders(NextResponse.json(json, { status }));
    }

    if (vendor === 'housejet-ppc') {
      const date = body.date as string;
      const time = body.time as string;
      if (!date || !time) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Missing date or time',
          'date and time are required when vendor is housejet-ppc. date: YYYY-MM-DD, time: e.g. 9:30am',
          { date: !!date, time: !!time },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      if (!isValidDate(date)) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid date',
          'date must be YYYY-MM-DD',
          { providedValue: date },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      const normalizedTime = normalizeTimeForCalendly(time);
      if (!normalizedTime || !/^\d{1,2}:\d{2}(am|pm)$/.test(normalizedTime)) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid time',
          'time must be like 9:30am or 2:00 PM',
          { providedValue: time },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      const calendlyUrl = getDirectPaypercloseCalendlyUrl({
        date,
        time,
        firstName,
        lastName,
        email,
        phone,
        calendlyType: 'payperclose',
      });

      const xanoRequestBody = { calendly_url: calendlyUrl };
      console.log('[housejet-ppc xano] request', {
        url: BOOK_HOUSEJET_PPC_URL,
        method: 'POST',
        body: xanoRequestBody,
      });

      try {
        const res = await fetch(BOOK_HOUSEJET_PPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(xanoRequestBody),
          signal: AbortSignal.timeout(15000),
        });
        const resJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        console.log('[housejet-ppc xano] response', {
          status: res.status,
          ok: res.ok,
          body: resJson,
        });

        if (!res.ok) {
          const errMsg =
            (resJson.message as string) ||
            (resJson.error as string) ||
            `External API returned ${res.status}`;
          const errorResponse = ErrorHandler.createError(
            ErrorCode.SCRAPING_FAILED,
            errMsg,
            errMsg,
            { status: res.status, response: resJson },
            requestId,
            Date.now() - requestStartTime
          );
          return security.addSecurityHeaders(
            NextResponse.json(errorResponse, { status: STATUS_FAILURE })
          );
        }
        const successResponse = ErrorHandler.createSuccess(
          SuccessCode.OPERATION_SUCCESS,
          {
            message: 'Housejet PPC booking requested',
            vendor: 'housejet-ppc',
            date,
            time,
            ...(resJson && typeof resJson === 'object' && Object.keys(resJson).length > 0
              ? { externalResponse: resJson }
              : {}),
          },
          requestId,
          Date.now() - requestStartTime
        );
        return security.addSecurityHeaders(
          NextResponse.json(successResponse, { status: STATUS_SUCCESS })
        );
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        console.log('[housejet-ppc xano] request failed', { error: errMessage });
        const errorResponse = ErrorHandler.createError(
          ErrorCode.SCRAPING_FAILED,
          errMessage,
          errMessage,
          { originalError: errMessage },
          requestId,
          Date.now() - requestStartTime
        );
        return security.addSecurityHeaders(
          NextResponse.json(errorResponse, { status: STATUS_FAILURE })
        );
      }
    }

    if (vendor === 'brivity') {
      const phoneTrimmed = (phone || '').trim();
      if (!phoneTrimmed) {
        const responseTime = Date.now() - requestStartTime;
        console.log('[brivity] validation failed', { requestId, reason: 'missing_phone' });
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Missing phone',
          'phone is required when vendor is brivity',
          undefined,
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      const parsed = resolveBookSlotDateTime({
        dateTime: body.dateTime as string | undefined,
        date: body.date as string | undefined,
        time: body.time as string | undefined,
      });
      if (!parsed) {
        const responseTime = Date.now() - requestStartTime;
        console.log('[brivity] validation failed', {
          requestId,
          reason: 'missing_or_invalid_datetime',
          dateTime: body.dateTime,
          date: body.date,
          time: body.time,
        });
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Missing date/time',
          'Provide dateTime (e.g. "November 13, 2025 at 1:25 PM CST") or both date (YYYY-MM-DD) and time (e.g. 1:25 PM) (vendor brivity)',
          undefined,
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      const { date: brivityDate, time: brivityTime } = parsed;
      if (!isValidDate(brivityDate)) {
        const responseTime = Date.now() - requestStartTime;
        console.log('[brivity] validation failed', { requestId, reason: 'invalid_date', date: brivityDate });
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid date',
          'date must be YYYY-MM-DD',
          { providedValue: brivityDate },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      const normalizedTimeBrivity = normalizeTimeForCalendly(brivityTime);
      if (!normalizedTimeBrivity || !/^\d{1,2}:\d{2}(am|pm)$/.test(normalizedTimeBrivity)) {
        const responseTime = Date.now() - requestStartTime;
        console.log('[brivity] validation failed', { requestId, reason: 'invalid_time', time: brivityTime });
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid time',
          'time must be like 9:30am or 2:00 PM',
          { providedValue: brivityTime },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      const unixSec = unixSecondsInCentral(brivityDate, brivityTime);
      if (unixSec === null) {
        const responseTime = Date.now() - requestStartTime;
        console.log('[brivity] validation failed', {
          requestId,
          reason: 'unix_compute_failed',
          date: brivityDate,
          time: brivityTime,
        });
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid date/time',
          'Could not compute booking instant for vendor brivity',
          { date: brivityDate, time: brivityTime },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      const dStr = String(unixSec);
      let brivityUrlHost = '';
      try {
        brivityUrlHost = new URL(BOOK_BRIVITY_URL).host;
      } catch {
        brivityUrlHost = '(invalid BOOK_BRIVITY_URL)';
      }

      console.log('[brivity xano] start', {
        requestId,
        date: brivityDate,
        time: brivityTime,
        dateTime: body.dateTime,
        d: dStr,
        urlHost: brivityUrlHost,
      });

      const xanoBody: Record<string, string> = {
        d: dStr,
        m: '30',
        first_name: firstName,
        last_name: lastName,
        email,
        phone: phoneTrimmed,
        full_phone: toFullPhoneUs(phoneTrimmed),
      };

      console.log('[brivity xano] request', {
        url: BOOK_BRIVITY_URL,
        method: 'POST',
        body: xanoBody,
      });

      try {
        const res = await fetch(BOOK_BRIVITY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(xanoBody),
          signal: AbortSignal.timeout(15000),
        });
        const resJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        console.log('[brivity xano] response', {
          status: res.status,
          ok: res.ok,
          body: resJson,
        });

        const msgRaw = resJson.message;
        const messageStr = typeof msgRaw === 'string' ? msgRaw.trim().toLowerCase() : '';

        if (!res.ok) {
          const errMsg =
            (typeof resJson.message === 'string' && resJson.message) ||
            (typeof resJson.error === 'string' && resJson.error) ||
            `External API returned ${res.status}`;
          console.log('[brivity xano] outcome', {
            requestId,
            outcome: 'http_error',
            clientStatus: STATUS_FAILURE,
            httpStatus: res.status,
          });
          const errorResponse = ErrorHandler.createError(
            ErrorCode.SCRAPING_FAILED,
            errMsg,
            errMsg,
            { status: res.status, response: resJson },
            requestId,
            Date.now() - requestStartTime
          );
          return security.addSecurityHeaders(
            NextResponse.json(errorResponse, { status: STATUS_FAILURE })
          );
        }

        if (messageStr === 'success') {
          console.log('[brivity xano] outcome', {
            requestId,
            outcome: 'success',
            clientStatus: STATUS_SUCCESS,
          });
          const successResponse = ErrorHandler.createSuccess(
            SuccessCode.OPERATION_SUCCESS,
            {
              message: 'Brivity booking succeeded',
              vendor: 'brivity',
              date: brivityDate,
              time: brivityTime,
              externalResponse: resJson,
            },
            requestId,
            Date.now() - requestStartTime
          );
          return security.addSecurityHeaders(
            NextResponse.json(successResponse, { status: STATUS_SUCCESS })
          );
        }

        if (messageStr === 'failed') {
          console.log('[brivity xano] outcome', {
            requestId,
            outcome: 'failed',
            clientStatus: STATUS_FAILURE,
          });
          const errorResponse = ErrorHandler.createError(
            ErrorCode.SCRAPING_FAILED,
            'Brivity booking failed',
            (typeof resJson.message === 'string' && resJson.message) || 'Xano reported booking failure',
            { response: resJson },
            requestId,
            Date.now() - requestStartTime
          );
          return security.addSecurityHeaders(
            NextResponse.json(errorResponse, { status: STATUS_FAILURE })
          );
        }

        console.log('[brivity xano] outcome', {
          requestId,
          outcome: 'unexpected_message',
          clientStatus: STATUS_FAILURE,
          message: msgRaw,
        });
        const errorResponse = ErrorHandler.createError(
          ErrorCode.SCRAPING_FAILED,
          'Unexpected response from Brivity API',
          `Expected message success or failed, got: ${String(msgRaw)}`,
          { response: resJson },
          requestId,
          Date.now() - requestStartTime
        );
        return security.addSecurityHeaders(
          NextResponse.json(errorResponse, { status: STATUS_FAILURE })
        );
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        console.log('[brivity xano] request failed', { requestId, error: errMessage });
        const errorResponse = ErrorHandler.createError(
          ErrorCode.SCRAPING_FAILED,
          errMessage,
          errMessage,
          { originalError: errMessage },
          requestId,
          Date.now() - requestStartTime
        );
        return security.addSecurityHeaders(
          NextResponse.json(errorResponse, { status: STATUS_FAILURE })
        );
      }
    }

    if (vendor === 'agentfire') {
      const date = body.date as string;
      const time = body.time as string;
      if (!date || !time) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Missing date or time',
          'date and time are required when vendor is agentfire. date: YYYY-MM-DD, time: e.g. 9:30am',
          { date: !!date, time: !!time },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      if (!isValidDate(date)) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid date',
          'date must be YYYY-MM-DD',
          { providedValue: date },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      const normalizedTime = normalizeTimeForCalendly(time);
      if (!normalizedTime || !/^\d{1,2}:\d{2}(am|pm)$/.test(normalizedTime)) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid time',
          'time must be like 9:30am or 2:00 PM',
          { providedValue: time },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      let answersRecord: Record<string, string | string[]> = {};
      const answers = body.answers;
      if (answers != null && typeof answers === 'object' && !Array.isArray(answers)) {
        for (const [k, v] of Object.entries(answers)) {
          if (typeof v === 'string') answersRecord[k] = v;
          else if (Array.isArray(v)) answersRecord[k] = v.filter((x): x is string => typeof x === 'string');
          else if (v != null) answersRecord[k] = String(v);
        }
      }

      const result = await concurrencyManager.execute(
        () =>
          bookCalendlySlot({
            date,
            time,
            firstName,
            lastName,
            email,
            phone,
            calendlyType: 'agentfire',
            answers: Object.keys(answersRecord).length > 0 ? answersRecord : undefined,
          }),
        45000
      );

      const responseTime = Date.now() - requestStartTime;

      if (!result.success) {
        const err = (result.error ?? '').toLowerCase();
        const isTimeout = err.includes('timed out') || err.includes('timeout');
        const isValidation = err.includes('validation') || (result.missingFields?.length ?? 0) > 0;
        const isSlot = !isTimeout && (err.includes('slot') || err.includes('time'));
        const isDay = !isTimeout && (err.includes('day') || err.includes('month'));
        const code = isTimeout
          ? ErrorCode.REQUEST_TIMEOUT
          : isValidation
            ? ErrorCode.VALIDATION_ERROR
            : isSlot
              ? ErrorCode.SLOT_NOT_FOUND
              : isDay
                ? ErrorCode.DAY_BUTTON_NOT_FOUND
                : ErrorCode.SCRAPING_FAILED;
        const metadata: Record<string, unknown> = { originalError: result.error };
        if (result.failedAfterStep) metadata.failedAfterStep = result.failedAfterStep;
        if (result.missingFields?.length) metadata.missingFields = result.missingFields;
        if (result.validationMessages?.length) metadata.validationMessages = result.validationMessages;
        if (result.videoPath) metadata.videoPath = result.videoPath;
        const errorResponse = ErrorHandler.createError(
          code,
          result.error || 'Booking failed',
          result.error || 'Calendly booking failed',
          metadata,
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(
          NextResponse.json(errorResponse, { status: STATUS_FAILURE })
        );
      }

      const successResponse = ErrorHandler.createSuccess(
        SuccessCode.OPERATION_SUCCESS,
        {
          message: 'Calendly slot booked successfully',
          vendor: 'agentfire',
          date: result.date,
          time: result.time,
        },
        requestId,
        responseTime
      );
      return security.addSecurityHeaders(
        NextResponse.json(successResponse, { status: STATUS_SUCCESS })
      );
    }

    if (vendor === 'lofty') {
      const date = body.date as string;
      const time = body.time as string;
      if (!date || !time) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Missing date or time',
          'date and time are required when vendor is lofty. date: YYYY-MM-DD, time: e.g. 9:30am',
          { date: !!date, time: !!time },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      if (!isValidDate(date)) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid date',
          'date must be YYYY-MM-DD',
          { providedValue: date },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      const normalizedTime = normalizeTimeForCalendly(time);
      if (!normalizedTime || !/^\d{1,2}:\d{2}(am|pm)$/.test(normalizedTime)) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid time',
          'time must be like 9:30am or 2:00 PM',
          { providedValue: time },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      const result = await concurrencyManager.execute(
        () =>
          bookLoftySlot({
            date,
            time,
            firstName,
            lastName,
            email,
            phone,
          }),
        45000
      );

      const responseTime = Date.now() - requestStartTime;

      if (!result.success) {
        const errorResponse = ErrorHandler.createError(
          ErrorCode.SCRAPING_FAILED,
          result.error || 'Lofty booking failed',
          result.error || 'Lofty booking failed',
          { vendor: 'lofty' },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(
          NextResponse.json(errorResponse, { status: STATUS_FAILURE })
        );
      }

      const successResponse = ErrorHandler.createSuccess(
        SuccessCode.OPERATION_SUCCESS,
        {
          message: 'Lofty slot booked successfully',
          vendor: 'lofty',
          date,
          time,
        },
        requestId,
        responseTime
      );
      return security.addSecurityHeaders(
        NextResponse.json(successResponse, { status: STATUS_SUCCESS })
      );
    }

    const loftyL2Vendors = ['lofty-5-9', 'lofty-10-24', 'lofty-25'] as const;
    if (loftyL2Vendors.includes(vendor as (typeof loftyL2Vendors)[number])) {
      const date = body.date as string;
      const time = body.time as string;
      if (!date || !time) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Missing date or time',
          'date and time are required when vendor is lofty-5-9, lofty-10-24, or lofty-25. date: YYYY-MM-DD, time: e.g. 9:30am',
          { date: !!date, time: !!time },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      if (!isValidDate(date)) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid date',
          'date must be YYYY-MM-DD',
          { providedValue: date },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }
      const normalizedTime = normalizeTimeForCalendly(time);
      if (!normalizedTime || !/^\d{1,2}:\d{2}(am|pm)$/.test(normalizedTime)) {
        const responseTime = Date.now() - requestStartTime;
        const errorResponse = ErrorHandler.createError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid time',
          'time must be like 9:30am or 2:00 PM',
          { providedValue: time },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
      }

      const result = await concurrencyManager.execute(
        () =>
          bookLoftySlotL2({
            date,
            time,
            firstName,
            lastName,
            email,
            phone,
          }),
        45000
      );

      const responseTime = Date.now() - requestStartTime;

      if (!result.success) {
        const errorResponse = ErrorHandler.createError(
          ErrorCode.SCRAPING_FAILED,
          result.error || 'Lofty L2 booking failed',
          result.error || 'Lofty L2 booking failed',
          { vendor },
          requestId,
          responseTime
        );
        return security.addSecurityHeaders(
          NextResponse.json(errorResponse, { status: STATUS_FAILURE })
        );
      }

      const successResponse = ErrorHandler.createSuccess(
        SuccessCode.OPERATION_SUCCESS,
        {
          message: 'Lofty L2 slot booked successfully',
          vendor,
          date,
          time,
        },
        requestId,
        responseTime
      );
      return security.addSecurityHeaders(
        NextResponse.json(successResponse, { status: STATUS_SUCCESS })
      );
    }

    const responseTime = Date.now() - requestStartTime;
    const errorResponse = ErrorHandler.createError(
      ErrorCode.VALIDATION_ERROR,
      'Invalid vendor',
      `vendor must be one of: ${VENDORS.join(', ')}`,
      undefined,
      requestId,
      responseTime
    );
    return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Book API error:', error);
    const responseTime = Date.now() - requestStartTime;
    if (err?.message?.includes('timeout')) {
      const errorResponse = ErrorHandler.createError(
        ErrorCode.REQUEST_TIMEOUT,
        'Booking timed out',
        'Request timed out. Please try again.',
        { queueStatus: concurrencyManager.getStatus(), originalError: err.message },
        requestId,
        responseTime
      );
      return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
    }
    if (err?.message?.includes('queue is full')) {
      const errorResponse = ErrorHandler.createError(
        ErrorCode.QUEUE_FULL,
        'Request queue is full',
        'Too many requests. Please try again later.',
        { queueStatus: concurrencyManager.getStatus(), originalError: err.message },
        requestId,
        responseTime
      );
      return security.addSecurityHeaders(NextResponse.json(errorResponse, { status: STATUS_FAILURE }));
    }
    const errorResponse = ErrorHandler.parseError(error, requestId, responseTime);
    return security.addSecurityHeaders(
      NextResponse.json(errorResponse, { status: STATUS_FAILURE })
    );
  }
}

export async function OPTIONS(request: NextRequest) {
  return security.configureCORS(new NextResponse(null, { status: 200 }));
}
