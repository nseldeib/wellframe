import { describe, it, expect, afterEach } from 'vitest';
import { rewriteIndexHtml, resolveFrontendDir } from './webserver.js';

describe('rewriteIndexHtml', () => {
  const SRC =
    '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n' +
    '    <script type="module" src="./assets/index.js"></script>\n  </head>\n' +
    '  <body><div id="root"></div></body>\n</html>';

  // A refresh on a deep client route must still load the hashed assets, which
  // are referenced relatively — the injected base href resolves them from root.
  it('injects a base href so deep-route relative assets resolve from root', () => {
    const out = rewriteIndexHtml(SRC);
    expect(out).toContain('<base href="/">');
    // injected inside <head>, before the original module script
    expect(out.indexOf('<base href="/">')).toBeLessThan(out.indexOf('./assets/index.js'));
  });

  // The marker is a separate external script so the desktop build's strict
  // `default-src 'self'` CSP (which forbids inline script) still allows it.
  it('injects the external web-mode marker script kept external for the strict CSP', () => {
    expect(rewriteIndexHtml(SRC)).toContain('<script src="/__wellframe-web.js"></script>');
  });

  // The rewrite is additive: the original CSP meta, module script, and root div
  // are all preserved untouched.
  it('leaves the original document CSP meta, module script and root div intact', () => {
    const out = rewriteIndexHtml(SRC);
    expect(out).toContain('<meta charset="UTF-8" />');
    expect(out).toContain('./assets/index.js');
    expect(out).toContain('<div id="root"></div>');
  });
});

describe('resolveFrontendDir', () => {
  const saved = process.env.WELLFRAME_WEB_DIST;
  afterEach(() => {
    if (saved === undefined) delete process.env.WELLFRAME_WEB_DIST;
    else process.env.WELLFRAME_WEB_DIST = saved;
  });

  // The override is a candidate, not an unchecked answer: a path with no
  // index.html must be rejected so a mistyped WELLFRAME_WEB_DIST can't make the
  // server serve a directory that isn't a frontend build.
  it('does not accept an override path that lacks an index.html', () => {
    process.env.WELLFRAME_WEB_DIST = '/definitely/not/a/real/frontend/dir';
    expect(resolveFrontendDir()).not.toBe('/definitely/not/a/real/frontend/dir');
  });
});
