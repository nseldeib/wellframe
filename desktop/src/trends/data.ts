// Trends data source. The native Tauri app invokes `get_trends`, which returns
// the raw metrics + their points; this layer stitches points onto metrics (the
// same JS join the web app's loader did — the models are flat, no FK). In the
// browser preview (no Tauri) it falls back to a `?s=` fixture. Production starts
// empty → no metrics → the day-one "no history yet" state.

import type { TrendsData, TrendMetric, TrendPoint, TrendMetricWithPoints } from './models';
import { FIXTURES, type ScenarioName } from './fixtures';
import { fromWebApi } from '../webApi';

interface TrendsRaw {
  metrics: TrendMetric[];
  points: TrendPoint[];
}

// Stitch points onto their metrics (flat models, no FK) and read the range deep
// link. Shared by the native (Tauri) and web-API paths.
function deriveTrends(raw: TrendsRaw): TrendsData {
  const byMetric = new Map<number, TrendPoint[]>();
  for (const p of raw.points) {
    const list = byMetric.get(p.metricId);
    if (list) list.push(p);
    else byMetric.set(p.metricId, [p]);
  }
  const withPoints: TrendMetricWithPoints[] = [];
  for (const m of raw.metrics) withPoints.push({ ...m, points: byMetric.get(m.id) ?? [] });
  const params = new URLSearchParams(window.location.search);
  return {
    metrics: withPoints,
    dateLabel: withPoints.length > 0 ? 'Trailing history' : 'Awaiting first sync',
    initialRange: params.get('range') ?? 'weekly',
  };
}

async function fromNative(): Promise<TrendsData | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return deriveTrends(await invoke<TrendsRaw>('get_trends'));
  } catch {
    return null; // not running under Tauri
  }
}

async function fromWeb(): Promise<TrendsData | null> {
  const raw = await fromWebApi<TrendsRaw>('/trends');
  return raw ? deriveTrends(raw) : null;
}

function fromFixture(): TrendsData {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('s') as ScenarioName | null;
  if (requested && requested in FIXTURES) return FIXTURES[requested];
  return FIXTURES.Rich;
}

export async function loadTrends(): Promise<TrendsData> {
  return (await fromNative()) ?? (await fromWeb()) ?? fromFixture();
}
