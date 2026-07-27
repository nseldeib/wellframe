import { describe, it, expect } from 'vitest';
import {
  validateConnectInput,
  resolveConnection,
  mergeCatalog,
  activeCoach,
  maskKey,
  AI_PROVIDERS,
  HEALTH_SOURCES,
  type ConnectionRow,
} from './connections';

describe('validateConnectInput', () => {
  // An API key must be present and non-trivial; empty or too-short is rejected.
  it('requires a non-trivial API key', () => {
    expect(validateConnectInput('apiKey', '')).toBeTruthy();
    expect(validateConnectInput('apiKey', 'short')).toBeTruthy();
    expect(validateConnectInput('apiKey', 'sk-abcdef123456')).toBeNull();
  });

  // A local endpoint accepts a URL or host:port, but rejects free text.
  it('accepts url or host:port endpoints, rejects junk', () => {
    expect(validateConnectInput('localEndpoint', 'http://localhost:11434')).toBeNull();
    expect(validateConnectInput('localEndpoint', 'localhost:11434')).toBeNull();
    expect(validateConnectInput('localEndpoint', 'not an address')).toBeTruthy();
  });

  // OAuth carries no user-entered value, so it validates with empty input.
  it('needs no input for oauth', () => {
    expect(validateConnectInput('oauth', '')).toBeNull();
  });
});

describe('resolveConnection', () => {
  // An unknown provider or a method the provider doesn't support fails to resolve.
  it('rejects unknown providers and unsupported methods', () => {
    expect(resolveConnection('nope', 'apiKey', 'x').ok).toBe(false);
    // ollama only supports localEndpoint
    expect(resolveConnection('ollama', 'apiKey', 'sk-abcdefghijkl').ok).toBe(false);
  });

  // An AI apiKey connect resolves to connected, with the key masked in the detail.
  it('maps an AI apiKey connect to connected + masked detail', () => {
    const r = resolveConnection('claude', 'apiKey', 'sk-abcdef123456');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('connected');
      expect(r.detail).toContain('3456');
      expect(r.detail).toContain('••••');
    }
  });

  // A health-source oauth connect resolves to the synced status.
  it('maps a health oauth connect to synced', () => {
    const r = resolveConnection('apple', 'oauth', '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('synced');
  });

  // A local endpoint that can't be reached fails; a reachable one resolves ok.
  it('fails an obviously-offline local endpoint', () => {
    expect(resolveConnection('ollama', 'localEndpoint', 'http://localhost:9999').ok).toBe(false);
    expect(resolveConnection('ollama', 'localEndpoint', 'http://localhost:11434').ok).toBe(true);
  });
});

describe('mergeCatalog + activeCoach', () => {
  const row: ConnectionRow = {
    providerId: 'claude',
    kind: 'ai',
    method: 'apiKey',
    status: 'connected',
    detail: 'Key ••••3456',
    endpoint: null,
    isActiveCoach: true,
    connectedAt: '2026-01-01T00:00:00.000Z',
  };

  // A stored connection marks its catalog provider connected and surfaces as the active coach.
  it('marks the stored provider connected and surfaces the active coach', () => {
    const views = mergeCatalog(AI_PROVIDERS, [row]);
    const claude = views.find((v) => v.id === 'claude')!;
    expect(claude.connected).toBe(true);
    expect(claude.isActiveCoach).toBe(true);
    expect(activeCoach(views)?.id).toBe('claude');
  });

  // An errored connection row does not count the provider as connected.
  it('does not count an errored row as connected', () => {
    const views = mergeCatalog(HEALTH_SOURCES, [
      { ...row, providerId: 'oura', kind: 'health', status: 'error', isActiveCoach: false },
    ]);
    expect(views.find((v) => v.id === 'oura')!.connected).toBe(false);
  });

  // With no stored connections, every catalog provider is unconnected.
  it('leaves uncatalogued providers unconnected', () => {
    expect(mergeCatalog(AI_PROVIDERS, []).every((v) => !v.connected)).toBe(true);
  });
});

describe('maskKey', () => {
  // Only the last four characters survive; a too-short key masks entirely.
  it('keeps the last four', () => {
    expect(maskKey('sk-abcdef1234')).toBe('••••1234');
    expect(maskKey('xy')).toBe('••••');
  });
});
