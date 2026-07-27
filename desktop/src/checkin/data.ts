// Daily Check-in data source. The native Tauri app invokes `get_checkin`, which
// returns recent Mood rows (most recent first); this layer derives the metabar
// label and the default morning/evening part-of-day. In the browser preview (no
// Tauri) it falls back to a `?s=` fixture. Production starts empty → no check-ins
// → the day-one state with an open form.

import type { CheckinData, Mood } from './models';
import { inferPartOfDay, PARTS_OF_DAY, type PartOfDay, type CheckinDraft } from './checkin';
import { FIXTURES, type ScenarioName } from './fixtures';
import { fromWebApi } from '../webApi';

// Under Tauri the write path persists to SQLite; in the browser preview there's
// no backend, so a submit is a local no-op (the form resets, nothing persists).
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Derive the metabar label and default morning/evening part-of-day from the
// Mood rows. Shared by the native (Tauri) and web-API paths.
function deriveCheckin(checkins: Mood[]): CheckinData {
  const params = new URLSearchParams(window.location.search);
  const part = params.get('part') ?? '';
  const defaultPartOfDay: PartOfDay = (PARTS_OF_DAY as readonly string[]).includes(part)
    ? (part as PartOfDay)
    : inferPartOfDay(new Date().getHours());
  return {
    checkins,
    dateLabel: checkins.length > 0 ? 'Logging' : 'Awaiting first check-in',
    defaultPartOfDay,
  };
}

async function fromNative(): Promise<CheckinData | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return deriveCheckin(await invoke<Mood[]>('get_checkin'));
  } catch {
    return null; // not running under Tauri
  }
}

async function fromWeb(): Promise<CheckinData | null> {
  const checkins = await fromWebApi<Mood[]>('/checkin');
  return checkins ? deriveCheckin(checkins) : null;
}

function fromFixture(): CheckinData {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('s') as ScenarioName | null;
  if (requested && requested in FIXTURES) return FIXTURES[requested];
  return FIXTURES.Rich;
}

export async function loadCheckin(): Promise<CheckinData> {
  return (await fromNative()) ?? (await fromWeb()) ?? fromFixture();
}

// Persist a validated check-in (writes a Mood row, which the Timeline also
// reads). Emits `wf:data-changed` on success so the current console re-reads.
export async function submitCheckin(draft: CheckinDraft): Promise<{ ok: boolean; error?: string }> {
  if (!isTauri()) return { ok: true }; // browser preview: no persistence
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('submit_checkin', { input: draft });
    window.dispatchEvent(new Event('wf:data-changed'));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
