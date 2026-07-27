// Activity Timeline data source. The native Tauri app invokes `get_timeline`,
// which returns the four raw activity sources; this layer groups them into days
// with the ported `buildTimeline` helper (the same derivation the web app ran
// server-side). In the browser preview (no Tauri) it falls back to a `?s=`
// fixture. Production starts empty → no rows → the day-one empty state.

import type { TimelineData, Workout, DailyBriefing, Mood, Weight } from './models';
import { buildTimeline } from './timeline';
import { FIXTURES, type ScenarioName } from './fixtures';
import { fromWebApi } from '../webApi';

interface TimelineRaw {
  workouts: Workout[];
  briefings: DailyBriefing[];
  moods: Mood[];
  weights: Weight[];
}

// Group the raw activity sources into days and read the filter deep links. Both
// the native (Tauri) and web-API paths feed identically-shaped raw payloads
// through this same derivation.
function deriveTimeline(raw: TimelineRaw): TimelineData {
  const days = buildTimeline(raw);
  const params = new URLSearchParams(window.location.search);
  return {
    days,
    dateLabel: days.length > 0 ? days[0].dateLabel : 'Awaiting first sync',
    initialType: params.get('type') ?? 'all',
    initialQuery: params.get('q') ?? '',
  };
}

async function fromNative(): Promise<TimelineData | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return deriveTimeline(await invoke<TimelineRaw>('get_timeline'));
  } catch {
    return null; // not running under Tauri
  }
}

async function fromWeb(): Promise<TimelineData | null> {
  const raw = await fromWebApi<TimelineRaw>('/timeline');
  return raw ? deriveTimeline(raw) : null;
}

function fromFixture(): TimelineData {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('s') as ScenarioName | null;
  if (requested && requested in FIXTURES) return FIXTURES[requested];
  return FIXTURES.Rich;
}

export async function loadTimeline(): Promise<TimelineData> {
  return (await fromNative()) ?? (await fromWeb()) ?? fromFixture();
}
