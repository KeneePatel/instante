import { isId } from '@instante/contract';
import { describe, expect, it } from 'vitest';
import { manualClock, systemClock } from './clock.ts';
import { systemIds } from './ids.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the clock', () => {
  it('reads the system time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('stands still in tests until moved', () => {
    const clock = manualClock('2026-11-13T16:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-11-13T16:00:00.000Z');
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-11-13T16:00:01.500Z');
    clock.set('2027-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('hands out a fresh Date each time, so a caller can’t move it', () => {
    const clock = manualClock('2026-11-13T16:00:00.000Z');
    clock.now().setFullYear(1999);
    expect(clock.now().getFullYear()).toBe(2026);
  });

  it('refuses a time that is not a date, or has no time zone, and a move that is no number', () => {
    expect(() => manualClock('soon')).toThrow(/not a date with a time zone: soon/);
    expect(() => manualClock('2026-11-13T16:00:00')).toThrow(/not a date with a time zone/);
    expect(manualClock('2026-11-13T12:00:00-04:00').now().toISOString()).toBe(
      '2026-11-13T16:00:00.000Z',
    );
    const clock = manualClock('2026-11-13T16:00:00Z');
    expect(() => {
      clock.set('later');
    }).toThrow(/not a date/);
    expect(() => {
      clock.advance(Number.NaN);
    }).toThrow(/finite number/);
  });
});

describe('ids', () => {
  it('makes UUIDv7 row ids carrying the current millisecond', () => {
    const before = Date.now();
    const id = systemIds.uuid();
    const after = Date.now();
    expect(id).toMatch(UUID_V7);
    const ms = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it('never repeats a row id', () => {
    const ids = Array.from({ length: 1000 }, () => systemIds.uuid());
    expect(new Set(ids).size).toBe(1000);
  });

  it("makes the master resume's ids with the contract's generator", () => {
    const id = systemIds.documentId('x');
    expect(id).toMatch(/^x_/);
    expect(isId(id)).toBe(true);
    const many = Array.from({ length: 200 }, () => systemIds.documentId('b'));
    expect(new Set(many).size).toBe(200);
  });
});
