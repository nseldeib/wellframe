// Recovery Center data source. The native Tauri app invokes `get_recovery`,
// which returns the latest read plus its raw factors and actions; this layer
// stitches them into RecoveryReadFull (the same JS assembly the web loader did —
// flat models, no FK) and reads the factor/action deep links. In the browser
// preview (no Tauri) it falls back to a `?s=` fixture. Production starts empty →
// no read → the day-one empty state.

import type {
  RecoveryReadFull,
  RecoveryRead,
  RecoveryFactor,
  RecoveryAction,
} from './models';
import { FIXTURES, type ScenarioName } from './fixtures';
import { fromWebApi } from '../webApi';

export interface RecoveryData {
  recovery: RecoveryReadFull;
  dateLabel: string;
  initialFactorPos?: number;
  initialActionPos?: number;
}

interface RecoveryRaw {
  read: RecoveryRead | null;
  factors: RecoveryFactor[];
  actions: RecoveryAction[];
}

function deepLinks(): { initialFactorPos?: number; initialActionPos?: number } {
  const params = new URLSearchParams(window.location.search);
  const factorPos = params.get('factor') ? Number(params.get('factor')) : undefined;
  const actionPos = params.get('action') ? Number(params.get('action')) : undefined;
  return {
    initialFactorPos: Number.isFinite(factorPos) ? factorPos : undefined,
    initialActionPos: Number.isFinite(actionPos) ? actionPos : undefined,
  };
}

// Assemble the latest read with its factors + actions (flat models, no FK) and
// read the deep links. Shared by the native (Tauri) and web-API paths.
function deriveRecovery(raw: RecoveryRaw): RecoveryData {
  const recovery: RecoveryReadFull = raw.read
    ? { ...raw.read, factors: raw.factors, actions: raw.actions }
    : null;
  return {
    recovery,
    dateLabel: recovery?.dateLabel ?? 'Awaiting first sync',
    ...deepLinks(),
  };
}

async function fromNative(): Promise<RecoveryData | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return deriveRecovery(await invoke<RecoveryRaw>('get_recovery'));
  } catch {
    return null; // not running under Tauri
  }
}

async function fromWeb(): Promise<RecoveryData | null> {
  const raw = await fromWebApi<RecoveryRaw>('/recovery');
  return raw ? deriveRecovery(raw) : null;
}

function fromFixture(): RecoveryData {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('s') as ScenarioName | null;
  const recovery = requested && requested in FIXTURES ? FIXTURES[requested] : FIXTURES.Rich;
  return { recovery, dateLabel: recovery?.dateLabel ?? 'Awaiting first sync', ...deepLinks() };
}

export async function loadRecovery(): Promise<RecoveryData> {
  return (await fromNative()) ?? (await fromWeb()) ?? fromFixture();
}
