// Web-dashboard data layer. Reproduces the shapes of the desktop app's Tauri
// read commands (`get_dashboard`, `get_timeline`, …) in JS, so the SAME desktop
// frontend — when served by this mcpb's local web server instead of the Tauri
// shell — reads the user's REAL local SQLite through `/api/*` rather than the
// browser fixtures. One "data brain" (this + `analysis.ts`) now backs both the
// MCP tools and the web UI.
//
// The queries mirror the Rust readers in `desktop/src-tauri/src/lib.rs` column
// for column; the only transforms are snake_case→camelCase keys (matching the
// frontend `models.ts`) and coercing SQLite's 0/1 integer flags to real
// booleans. A missing DB (desktop app never run) yields the empty day-one
// payload instead of an error — the frontend then shows its empty states.

import { query, queryOne, DbMissingError } from './db.js';

type Row = Record<string, unknown>;

// `ord` is the one column whose camelCase form isn't a mechanical transform
// (the frontend models call it `order`); everything else is snake→camel.
export function camelKey(k: string): string {
  if (k === 'ord') return 'order';
  return k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

// Map a raw sql.js row (snake_case keys) to the frontend's camelCase shape,
// coercing the named 0/1 integer columns to booleans.
export function mapRow(raw: Row, booleanKeys: readonly string[] = []): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(raw)) out[camelKey(k)] = v;
  for (const b of booleanKeys) if (b in out) out[b] = Boolean(out[b]);
  return out;
}

async function rows(sql: string, params: unknown[] = [], booleanKeys: readonly string[] = []) {
  const rs = await query<Row>(sql, params);
  const out: Row[] = [];
  for (const r of rs) out.push(mapRow(r, booleanKeys));
  return out;
}

async function one(sql: string, params: unknown[] = [], booleanKeys: readonly string[] = []) {
  const r = await queryOne<Row>(sql, params);
  return r ? mapRow(r, booleanKeys) : null;
}

// Run a payload builder, but treat "no database yet" as the empty day-one state
// rather than an error (mirrors the desktop app, whose open_db creates an empty
// schema on first launch). Any other read error still propagates.
export async function emptyOnMissing<T>(build: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await build();
  } catch (e) {
    if (e instanceof DbMissingError) return empty;
    throw e;
  }
}

const BRIEFING_COLS =
  'id, date, date_label, readiness_score, readiness_label, readiness_delta, headline, ' +
  'status_line, elevation, wind, window_label, suggested_workout, coach_message, ' +
  'coach_directive, coach_signature';
const WORKOUT_COLS =
  'id, title, type_label, photo_url, distance, pace, vertical, duration, occurred_at, kind';
const MOOD_COLS =
  'id, occurred_at, part_of_day, energy, mood, sleep_quality, soreness, stress, note';

// GET /api/dashboard — latest briefing + ordered overnight vitals + latest workout.
export function dashboard() {
  return emptyOnMissing(
    async () => ({
      briefing: await one(`SELECT ${BRIEFING_COLS} FROM daily_briefing ORDER BY date DESC LIMIT 1`),
      vitals: await rows(
        'SELECT id, ord, label, value, unit, delta, track_pct, positive FROM vital ORDER BY ord ASC',
        [],
        ['positive'],
      ),
      workout: await one(`SELECT ${WORKOUT_COLS} FROM workout ORDER BY id DESC LIMIT 1`),
    }),
    { briefing: null, vitals: [], workout: null },
  );
}

// GET /api/timeline — the four raw activity sources; the frontend groups by day.
export function timeline() {
  return emptyOnMissing(
    async () => ({
      workouts: await rows(`SELECT ${WORKOUT_COLS} FROM workout`),
      briefings: await rows(`SELECT ${BRIEFING_COLS} FROM daily_briefing`),
      moods: await rows(`SELECT ${MOOD_COLS} FROM mood ORDER BY occurred_at DESC`),
      weights: await rows(
        'SELECT id, occurred_at, value, unit, delta, positive FROM weight',
        [],
        ['positive'],
      ),
    }),
    { workouts: [], briefings: [], moods: [], weights: [] },
  );
}

// GET /api/trends — every metric chart + its points; the frontend stitches them.
export function trends() {
  return emptyOnMissing(
    async () => ({
      metrics: await rows(
        'SELECT id, ord, metric_key, label, unit, range, latest, delta, positive, summary ' +
          'FROM trend_metric ORDER BY range ASC, ord ASC',
        [],
        ['positive'],
      ),
      points: await rows(
        'SELECT id, metric_id, ord, bucket_label, value FROM trend_point ORDER BY ord ASC',
      ),
    }),
    { metrics: [], points: [] },
  );
}

// GET /api/recovery — latest read plus its contributing factors and actions.
export function recovery() {
  return emptyOnMissing(
    async () => {
      const read = await one(
        'SELECT id, date, date_label, score, label, headline, status_line, summary ' +
          'FROM recovery_read ORDER BY date DESC LIMIT 1',
      );
      if (!read) return { read: null, factors: [], actions: [] };
      const rid = read.id;
      return {
        read,
        factors: await rows(
          'SELECT id, recovery_id, ord, label, value, state, track_pct, positive, detail ' +
            'FROM recovery_factor WHERE recovery_id = ? ORDER BY ord ASC',
          [rid],
          ['positive'],
        ),
        actions: await rows(
          'SELECT id, recovery_id, ord, title, kind, duration_label, detail ' +
            'FROM recovery_action WHERE recovery_id = ? ORDER BY ord ASC',
          [rid],
        ),
      };
    },
    { read: null, factors: [], actions: [] },
  );
}

// GET /api/goals — every goal in display order.
export function goals() {
  return emptyOnMissing(
    () =>
      rows(
        'SELECT id, ord, title, category, metric, target, current, unit, cadence, due_label, note, created_at ' +
          'FROM goal ORDER BY ord ASC, id ASC',
      ),
    [] as Row[],
  );
}

// GET /api/checkin — recent Mood rows, most recent first.
export function checkin() {
  return emptyOnMissing(() => rows(`SELECT ${MOOD_COLS} FROM mood ORDER BY occurred_at DESC`), [] as Row[]);
}

// The GET routes the web server exposes, keyed by path.
export const API_ROUTES: Record<string, () => Promise<unknown>> = {
  '/api/dashboard': dashboard,
  '/api/timeline': timeline,
  '/api/trends': trends,
  '/api/recovery': recovery,
  '/api/goals': goals,
  '/api/checkin': checkin,
};
