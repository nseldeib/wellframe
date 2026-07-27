// Wellframe Coach — MCP server. Exposes the coach's structured tools over the
// user's LOCAL Wellframe database (read-only). Nothing leaves the machine except
// what the AI host chooses to send; the server only reads local SQLite.
//
// Tools mirror the PRD's coach architecture: readiness, workouts, sleep, training
// load, recovery, goals, check-ins. Each returns structured JSON the model can
// reason over rather than free-form prose.

import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { query, queryOne, DB_PATH, DbMissingError } from './db.js';
import {
  fatigueIndex,
  generateTrainingPlan,
  toCheckinRatings,
  parseMetricNumber,
} from './analysis.js';
import { startWebServer } from './webserver.js';

const server = new McpServer({ name: 'wellframe-coach', version: '0.1.0' });

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

// Wrap a tool body so a missing DB (or any read error) returns a clean, useful
// message instead of crashing the server.
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    const msg = e instanceof DbMissingError ? e.message : `Wellframe read failed: ${String(e)}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

server.tool(
  'get_readiness',
  "Today's readiness briefing: the latest score, label, verdict headline, and the coach's note.",
  {},
  () =>
    run(() =>
      queryOne(
        `SELECT date_label, readiness_score, readiness_label, readiness_delta, headline,
                status_line, suggested_workout, coach_message, coach_directive
         FROM daily_briefing ORDER BY date DESC LIMIT 1`,
      ),
    ),
);

server.tool(
  'list_workouts',
  'Recent logged workouts (runs, rides, strength, etc.), most recent first.',
  { limit: z.number().int().positive().max(100).default(10) },
  ({ limit }) =>
    run(() =>
      query(
        `SELECT title, kind, distance, pace, vertical, duration, occurred_at
         FROM workout ORDER BY COALESCE(occurred_at, '') DESC, id DESC LIMIT ?`,
        [limit],
      ),
    ),
);

server.tool(
  'analyze_sleep',
  'Recent sleep signals: nightly sleep-quality self-ratings and any sleep trend series.',
  { nights: z.number().int().positive().max(60).default(14) },
  ({ nights }) =>
    run(async () => ({
      checkinSleepQuality: await query(
        `SELECT occurred_at, part_of_day, sleep_quality
         FROM mood WHERE sleep_quality IS NOT NULL ORDER BY occurred_at DESC LIMIT ?`,
        [nights],
      ),
      sleepTrends: await query(
        `SELECT m.range, m.latest, m.delta, m.summary
         FROM trend_metric m WHERE lower(m.metric_key) = 'sleep' OR lower(m.label) = 'sleep'`,
      ),
    })),
);

server.tool(
  'compute_training_load',
  'Current training load: the training-load trend metric plus a count of recent workouts by type.',
  {},
  () =>
    run(async () => ({
      trainingLoadMetric: await query(
        `SELECT range, latest, delta, summary FROM trend_metric
         WHERE lower(metric_key) IN ('training_load','load') OR lower(label) LIKE 'training%'`,
      ),
      workoutCountsByKind: await query(
        `SELECT COALESCE(kind, 'unknown') AS kind, COUNT(*) AS count FROM workout GROUP BY kind`,
      ),
    })),
);

server.tool(
  'recommend_recovery',
  'The current recovery read: score, contributing factors (sleep/HRV/RHR/load/stress), and suggested recovery actions.',
  {},
  () =>
    run(async () => {
      const read = await queryOne<{ id: number }>(
        `SELECT id, date_label, score, label, headline, status_line, summary
         FROM recovery_read ORDER BY date DESC LIMIT 1`,
      );
      if (!read) return { recovery: null };
      return {
        recovery: read,
        factors: await query(
          `SELECT label, value, state, detail FROM recovery_factor WHERE recovery_id = ? ORDER BY ord`,
          [read.id],
        ),
        suggestedActions: await query(
          `SELECT title, kind, duration_label, detail FROM recovery_action WHERE recovery_id = ? ORDER BY ord`,
          [read.id],
        ),
      };
    }),
);

server.tool(
  'list_goals',
  'Tracked goals with current progress toward each target.',
  {},
  () =>
    run(() =>
      query(
        `SELECT title, category, metric, target, current, unit, cadence, due_label,
                CASE WHEN target > 0 THEN ROUND(100.0 * current / target, 1) ELSE NULL END AS percent
         FROM goal ORDER BY ord, id`,
      ),
    ),
);

server.tool(
  'recent_checkins',
  'Recent daily check-ins (morning/evening) with energy, mood, sleep, soreness, stress, and reflection notes.',
  { limit: z.number().int().positive().max(60).default(14) },
  ({ limit }) =>
    run(() =>
      query(
        `SELECT occurred_at, part_of_day, energy, mood, sleep_quality, soreness, stress, note
         FROM mood ORDER BY occurred_at DESC LIMIT ?`,
        [limit],
      ),
    ),
);

// Shared gather for the fatigue-derived tools: latest recovery score, recent
// check-in ratings, and the training-load trend (numeric, for context).
async function fatigueInputs() {
  const recovery = await queryOne<{ score: number | null }>(
    `SELECT score FROM recovery_read ORDER BY date DESC LIMIT 1`,
  );
  const checkins = await query<{
    energy: number | null;
    soreness: number | null;
    stress: number | null;
    sleep_quality: number | null;
  }>(
    `SELECT energy, soreness, stress, sleep_quality FROM mood ORDER BY occurred_at DESC LIMIT 7`,
  );
  const tl = await queryOne<{ latest: string }>(
    `SELECT latest FROM trend_metric
     WHERE lower(metric_key) IN ('training_load','load') OR lower(label) LIKE 'training%' LIMIT 1`,
  );
  return {
    recoveryScore: recovery?.score ?? null,
    checkins: toCheckinRatings(checkins),
    trainingLoadLatest: parseMetricNumber(tl?.latest),
  };
}

server.tool(
  'estimate_fatigue',
  'Composite fatigue estimate (0–100) blending your recovery score and recent check-in ratings, with a band and per-signal breakdown.',
  {},
  () =>
    run(async () => {
      const inp = await fatigueInputs();
      return { ...fatigueIndex(inp), checkinsConsidered: inp.checkins.length };
    }),
);

server.tool(
  'generate_plan',
  'A day-by-day training plan modulated by your current fatigue, readiness, and goals (rest-led when fatigued, quality when fresh; folds in strength/volume by goal).',
  { days: z.number().int().min(1).max(28).default(7) },
  ({ days }) =>
    run(async () => {
      const inp = await fatigueInputs();
      const fat = fatigueIndex(inp);
      const readiness = await queryOne<{ readiness_label: string | null }>(
        `SELECT readiness_label FROM daily_briefing ORDER BY date DESC LIMIT 1`,
      );
      const goals = await query<{ title: string; category: string; target: number; current: number }>(
        `SELECT title, category, target, current FROM goal ORDER BY ord, id`,
      );
      return generateTrainingPlan({
        fatigue: fat.fatigue,
        band: fat.band,
        readinessLabel: readiness?.readiness_label ?? null,
        goals: goals.map((g) => ({
          title: g.title,
          category: g.category,
          percent: g.target > 0 ? Math.round((100 * g.current) / g.target) : null,
        })),
        days,
      });
    }),
);

// Open a URL in the user's default browser, best-effort and non-blocking. On a
// headless host (no browser) this simply fails quietly — the tool still returns
// the URL so the user can open it themselves.
function openBrowser(url: string): boolean {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

server.tool(
  'open_dashboard',
  'Launch the local Wellframe web dashboard — a browser view of your health data ' +
    '(readiness, vitals, activity timeline, trends, recovery, goals, check-ins), the same ' +
    'interface as the desktop app but served locally from this machine and fully offline. ' +
    'Starts a local web server (127.0.0.1 only, read-only over your local database), opens ' +
    'your browser, and returns the URL.',
  {},
  () =>
    run(async () => {
      const handle = await startWebServer();
      const opened = handle.frontendDir ? openBrowser(handle.url) : false;
      return {
        url: handle.url,
        opened,
        reused: handle.reused,
        webUiAvailable: Boolean(handle.frontendDir),
        note: handle.frontendDir
          ? opened
            ? `Wellframe dashboard opened at ${handle.url}`
            : `Wellframe dashboard is running at ${handle.url} — open it in your browser.`
          : `The Wellframe web UI build isn't in this bundle, but the local data API is ` +
            `running at ${handle.url} (endpoints under /api).`,
      };
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs (stdout is the MCP transport).
console.error(`wellframe-coach MCP server ready · db: ${DB_PATH}`);
