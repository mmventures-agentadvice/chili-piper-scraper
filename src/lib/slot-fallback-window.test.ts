import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  orderChiliSlotFallbackLabels,
  parseMinutesFromChiliSlotTestId,
  parseWallTimeToMinutes,
} from './slot-fallback-window';

describe('slot-fallback-window', () => {
  it('parseWallTimeToMinutes handles 12 AM and PM', () => {
    assert.equal(parseWallTimeToMinutes('12:00 AM'), 0);
    assert.equal(parseWallTimeToMinutes('12:30 AM'), 30);
    assert.equal(parseWallTimeToMinutes('12:00 PM'), 12 * 60);
    assert.equal(parseWallTimeToMinutes('1:30 PM'), 13 * 60 + 30);
  });

  it('parseMinutesFromChiliSlotTestId reads slot-test-id', () => {
    assert.equal(parseMinutesFromChiliSlotTestId('slot-1:30PM'), 13 * 60 + 30);
    assert.equal(parseMinutesFromChiliSlotTestId('slot-9:00AM'), 9 * 60);
  });

  it('orders future then past, closest first in each bucket (30 min window)', () => {
    const target = parseWallTimeToMinutes('2:00 PM')!;
    const slots = [
      { label: '1:45 PM', minutes: parseWallTimeToMinutes('1:45 PM')! },
      { label: '2:15 PM', minutes: parseWallTimeToMinutes('2:15 PM')! },
      { label: '2:30 PM', minutes: parseWallTimeToMinutes('2:30 PM')! },
      { label: '1:30 PM', minutes: parseWallTimeToMinutes('1:30 PM')! },
    ];
    const ordered = orderChiliSlotFallbackLabels(target, 30, slots);
    assert.deepEqual(ordered, ['2:15 PM', '2:30 PM', '1:45 PM', '1:30 PM']);
  });

  it('respects 15-minute window', () => {
    const target = parseWallTimeToMinutes('2:00 PM')!;
    const slots = [
      { label: '1:30 PM', minutes: parseWallTimeToMinutes('1:30 PM')! },
      { label: '1:45 PM', minutes: parseWallTimeToMinutes('1:45 PM')! },
      { label: '2:15 PM', minutes: parseWallTimeToMinutes('2:15 PM')! },
      { label: '2:30 PM', minutes: parseWallTimeToMinutes('2:30 PM')! },
    ];
    const ordered = orderChiliSlotFallbackLabels(target, 15, slots);
    assert.deepEqual(ordered, ['2:15 PM', '1:45 PM']);
  });
});
