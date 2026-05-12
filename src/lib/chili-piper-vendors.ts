/**
 * Chili Piper vendor configuration: URL and flow behavior per vendor.
 * Used by get-slots and book-slot to resolve base URL and direct-calendar / form-fill behavior.
 */

import type { SlotFallbackWindowMinutes } from './slot-fallback-window';

export type { SlotFallbackWindowMinutes } from './slot-fallback-window';

const DEFAULT_CINQ_URL =
  process.env.CHILI_PIPER_FORM_URL ||
  'https://cincpro.chilipiper.com/concierge-router/link/lp-request-a-demo-agent-advice';

const LUXURY_PRESENCE_URL =
  process.env.LUXURY_PRESENCE_CHILI_PIPER_URL ||
  process.env.LUXURYPRESENCE_CHILI_PIPER_URL ||
  'https://luxurypresence.chilipiper.com/round-robin/agentadvice-intro--15';

export interface ChiliPiperVendorConfig {
  formUrl: string;
  directCalendar: boolean;
  /** If true, after selecting a slot we must fill guest form (first/last/email) and click Confirm. */
  fillGuestFormAfterSlot: boolean;
  /** Default ± window (minutes) for slot fallback when env override is not set. */
  slotFallbackWindowMinutesDefault: SlotFallbackWindowMinutes;
}

function resolveChiliSlotFallbackWindowFromEnv(
  vendorDefault: SlotFallbackWindowMinutes
): SlotFallbackWindowMinutes {
  const raw = process.env.CHILI_SLOT_FALLBACK_WINDOW_MINUTES?.trim();
  if (raw === '15' || raw === '30') {
    return raw === '15' ? 15 : 30;
  }
  return vendorDefault;
}

export const CHILI_PIPER_VENDOR_CONFIG: Record<string, ChiliPiperVendorConfig> = {
  cinq: {
    formUrl: DEFAULT_CINQ_URL,
    directCalendar: false,
    fillGuestFormAfterSlot: false,
    slotFallbackWindowMinutesDefault: 30,
  },
  'luxury-presence': {
    formUrl: LUXURY_PRESENCE_URL,
    directCalendar: true,
    fillGuestFormAfterSlot: true,
    slotFallbackWindowMinutesDefault: 15,
  },
};

const DEFAULT_VENDOR = 'cinq';

/** Canonical vendor id for Chili Piper routing (`luxurypresence` is accepted as legacy alias). */
export function normalizeChiliPiperVendorId(vendor?: string | null): string {
  const k = (vendor || '').toLowerCase().trim() || DEFAULT_VENDOR;
  if (k === 'luxurypresence') return 'luxury-presence';
  return k;
}

/**
 * Resolve vendor config by id. Falls back to cinq/default when vendor is missing or unknown.
 * `slotFallbackWindowMinutes` is the effective window (env `CHILI_SLOT_FALLBACK_WINDOW_MINUTES` when 15|30, else vendor default).
 */
export function getChiliPiperVendorConfig(
  vendor?: string | null
): ChiliPiperVendorConfig & { slotFallbackWindowMinutes: SlotFallbackWindowMinutes } {
  const key = normalizeChiliPiperVendorId(vendor);
  const base = CHILI_PIPER_VENDOR_CONFIG[key] ?? CHILI_PIPER_VENDOR_CONFIG[DEFAULT_VENDOR];
  const slotFallbackWindowMinutes = resolveChiliSlotFallbackWindowFromEnv(
    base.slotFallbackWindowMinutesDefault
  );
  return { ...base, slotFallbackWindowMinutes };
}
