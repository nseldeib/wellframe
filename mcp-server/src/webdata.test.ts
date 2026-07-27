import { describe, it, expect } from 'vitest';
import { camelKey, mapRow, emptyOnMissing } from './webdata.js';
import { DbMissingError } from './db.js';

describe('camelKey', () => {
  // The frontend models call the sort column `order`, but SQLite reserves that
  // word so the column is `ord` — this one rename is what keeps the ported UI
  // reading the same field name it always has.
  it('maps ord → order and snake_case → camelCase', () => {
    expect(camelKey('ord')).toBe('order');
    expect(camelKey('track_pct')).toBe('trackPct');
    expect(camelKey('readiness_score')).toBe('readinessScore');
    expect(camelKey('is_active_coach')).toBe('isActiveCoach');
    expect(camelKey('id')).toBe('id');
  });
});

describe('mapRow', () => {
  // A raw sql.js row arrives with snake_case keys and 0/1 integer flags; the
  // frontend expects camelCase keys and real booleans, so both transforms must
  // happen together or a component's `positive ? …` branch reads a truthy 0.
  it('camelCases keys and coerces named integer flags to booleans', () => {
    const raw = { id: 1, ord: 2, track_pct: 80, positive: 1, label: 'HRV' };
    expect(mapRow(raw, ['positive'])).toEqual({
      id: 1,
      order: 2,
      trackPct: 80,
      positive: true,
      label: 'HRV',
    });
  });

  // A 0 flag must become false (not stay a falsy-but-present 0), and columns not
  // named as booleans must pass through untouched.
  it('coerces a 0 flag to false and leaves unlisted columns untouched', () => {
    const raw = { id: 3, positive: 0, state: 'watch' };
    const out = mapRow(raw, ['positive']);
    expect(out.positive).toBe(false);
    expect(out.state).toBe('watch');
  });

  // Nulls survive the mapping, and a boolean key that isn't present in the row
  // is not fabricated as `false`.
  it('preserves nulls and does not invent boolean keys that are absent', () => {
    const raw = { id: 4, unit: null };
    const out = mapRow(raw, ['positive']);
    expect(out.unit).toBeNull();
    expect('positive' in out).toBe(false);
  });
});

describe('emptyOnMissing', () => {
  // A missing database is the day-one state, not an error: the desktop app
  // creates an empty schema on first launch, so the web API must return the
  // empty payload (which renders the empty state) rather than surfacing a 500.
  it('returns the empty payload when the build throws DbMissingError', async () => {
    const empty = { briefing: null, vitals: [] };
    const out = await emptyOnMissing(async () => {
      throw new DbMissingError('/no/such.db');
    }, empty);
    expect(out).toBe(empty);
  });

  // When the database is present the builder's value is returned verbatim.
  it('passes through the built value when the database is present', async () => {
    const out = await emptyOnMissing(async () => ({ ok: 1 }), { ok: 0 });
    expect(out).toEqual({ ok: 1 });
  });

  // Only a missing DB is swallowed; any other read failure must propagate so a
  // real bug is never masked as an empty payload.
  it('rethrows non-missing errors so real read failures are not masked', async () => {
    await expect(
      emptyOnMissing(async () => {
        throw new Error('disk exploded');
      }, null),
    ).rejects.toThrow('disk exploded');
  });
});
