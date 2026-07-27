// Dashboard data source. In the native Tauri app this invokes the Rust
// `get_dashboard` command (reads local SQLite); in a plain browser — the
// codeyam live preview / `vite dev` — the Tauri API is absent, so it falls back
// to a named fixture chosen by the `?s=<Scenario>` query param. One shape
// (DashboardData) serves both, so the ported UI is unaware of the source.

import type { DashboardData } from './models';
import { FIXTURES, type ScenarioName } from './fixtures';
import { fromWebApi } from '../webApi';

async function fromNative(): Promise<DashboardData | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<DashboardData>('get_dashboard');
  } catch {
    return null; // not running under Tauri
  }
}

// Served by the mcpb web server: read real local data over the JSON API. The
// payload is already the DashboardData shape (no derivation needed).
function fromWeb(): Promise<DashboardData | null> {
  return fromWebApi<DashboardData>('/dashboard');
}

function fromFixture(): DashboardData {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('s') as ScenarioName | null;
  if (requested && requested in FIXTURES) return FIXTURES[requested];
  return FIXTURES.Primed;
}

export async function loadDashboard(): Promise<DashboardData> {
  return (await fromNative()) ?? (await fromWeb()) ?? fromFixture();
}
