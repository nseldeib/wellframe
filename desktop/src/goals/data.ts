// Goals data source. The native Tauri app invokes `get_goals`, which returns the
// goal rows in display order; this layer derives the metabar label and reads the
// composer-open deep link. In the browser preview (no Tauri) it falls back to a
// `?s=` fixture. Production starts empty → no goals → the day-one empty state.

import type { GoalsData, Goal } from './models';
import type { GoalDraft } from './goals';
import { FIXTURES, type ScenarioName } from './fixtures';
import { fromWebApi } from '../webApi';

// Under Tauri the write path persists to SQLite; in the browser preview there's
// no backend, so a submit is a local no-op (the form closes, nothing persists).
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Derive the metabar label and composer deep link from the goal rows. Shared by
// the native (Tauri) and web-API paths.
function deriveGoals(goals: Goal[]): GoalsData {
  const params = new URLSearchParams(window.location.search);
  return {
    goals,
    dateLabel: goals.length > 0 ? 'Tracking' : 'Awaiting first goal',
    initialComposing: params.get('new') === '1',
  };
}

async function fromNative(): Promise<GoalsData | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return deriveGoals(await invoke<Goal[]>('get_goals'));
  } catch {
    return null; // not running under Tauri
  }
}

async function fromWeb(): Promise<GoalsData | null> {
  const goals = await fromWebApi<Goal[]>('/goals');
  return goals ? deriveGoals(goals) : null;
}

function fromFixture(): GoalsData {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('s') as ScenarioName | null;
  if (requested && requested in FIXTURES) return FIXTURES[requested];
  return FIXTURES.Rich;
}

export async function loadGoals(): Promise<GoalsData> {
  return (await fromNative()) ?? (await fromWeb()) ?? fromFixture();
}

// Persist a validated new goal. Emits `wf:data-changed` on success so the app
// re-reads the current console and the new goal appears immediately.
export async function createGoal(draft: GoalDraft): Promise<{ ok: boolean; error?: string }> {
  if (!isTauri()) return { ok: true }; // browser preview: no persistence
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('create_goal', { input: { ...draft, createdAt: new Date().toISOString() } });
    window.dispatchEvent(new Event('wf:data-changed'));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
