// Web-mode data source. When this frontend is served by the Wellframe mcpb's
// local web server (not the Tauri shell and not the codeyam fixture preview), an
// injected marker script sets `window.__WELLFRAME_WEB_API__` to the local JSON
// API base. Each console's loader tries this tier AFTER native Tauri and BEFORE
// the browser fixture, so a mcpb-served page shows the user's REAL local data
// while the plain `vite dev` / codeyam preview still falls back to fixtures.
//
// The `/api/*` payloads are byte-for-byte the shapes the Tauri read commands
// return, so each loader runs the exact same derivation over them as it does
// over the native payload.

// The marker is absent unless the mcpb web server injected it, so this returns
// null in the Tauri app and in the fixture preview — both skip the web tier.
export function webApiBase(): string | null {
  const w = window as unknown as { __WELLFRAME_WEB_API__?: string };
  return typeof w.__WELLFRAME_WEB_API__ === 'string' ? w.__WELLFRAME_WEB_API__ : null;
}

// Fetch a raw payload from the local web API, or null if not in web mode / the
// request fails (the caller then falls through to its fixture).
export async function fromWebApi<T>(path: string): Promise<T | null> {
  const base = webApiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
