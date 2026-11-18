import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Window } from 'happy-dom';

const execFileAsync = promisify(execFile);

/** Extract top-level `location ... { ... }` blocks from an nginx config.
 * @param {string} conf
 * @returns {Array<{header: string, body: string}>} */
function extractLocationBlocks(conf) {
  /** @type {Array<{header: string, body: string}>} */
  const blocks = [];
  const matcher = /location\s+[^{]+\{/gu;
  let match;
  while ((match = matcher.exec(conf)) !== null) {
    let depth = 1;
    let index = matcher.lastIndex;
    while (index < conf.length && depth > 0) {
      if (conf[index] === '{') depth++;
      else if (conf[index] === '}') depth--;
      index++;
    }
    blocks.push({
      header: match[0].slice(0, -1).trim(),
      body: conf.slice(matcher.lastIndex, index - 1)
    });
  }
  return blocks;
}

test('R085: render-manifests.py rejects unresolved RELEASE_TAG across phases and substitutes frozen tags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-manifests-'));
  const script = new URL('../deploy/website/render-manifests.py', import.meta.url).pathname;
  try {
    const prepareOut = join(dir, 'prepare.yaml');
    await execFileAsync('python3', [
      script,
      '--phase', 'prepare',
      '--image', 'docker.io/library/codelync-website:1.0.0',
      '--output', prepareOut
    ]);
    const prepared = await readFile(prepareOut, 'utf8');
    assert.match(prepared, /docker\.io\/library\/codelync-website:1\.0\.0/);
    assert.doesNotMatch(prepared, /RELEASE_TAG/);
    assert.doesNotMatch(prepared, /^kind: Ingress$/mu);

    const routeOut = join(dir, 'route.yaml');
    await execFileAsync('python3', [script, '--phase', 'route', '--output', routeOut]);
    const routed = await readFile(routeOut, 'utf8');
    assert.match(routed, /^kind: Ingress$/mu);
    assert.doesNotMatch(routed, /RELEASE_TAG/);

    await assert.rejects(
      execFileAsync('python3', [
        script,
        '--phase', 'prepare',
        '--image', 'docker.io/library/codelync-website:RELEASE_TAG',
        '--output', join(dir, 'bad.yaml')
      ])
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R085: nginx configs preserve security-headers.conf on every add_header location and enforce GET-only static endpoints', async () => {
  const [nginxConf, legacyConf, securityHeaders] = await Promise.all([
    readFile(new URL('../deploy/website/nginx.conf', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/website/legacy-nginx.conf', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/website/security-headers.conf', import.meta.url), 'utf8')
  ]);

  assert.match(securityHeaders, /frame-ancestors 'none'/u);
  assert.doesNotMatch(securityHeaders, /unsafe-inline|unsafe-eval/u);

  for (const [name, conf] of [['nginx.conf', nginxConf], ['legacy-nginx.conf', legacyConf]]) {
    assert.match(conf, /include \/etc\/nginx\/security-headers\.conf;/u, `${name} server block must include security-headers.conf`);
    const locations = extractLocationBlocks(conf);
    assert.ok(locations.length >= 3, `${name} should define expected locations`);
    for (const loc of locations) {
      if (loc.body.includes('add_header')) {
        assert.match(loc.body, /include \/etc\/nginx\/security-headers\.conf;/u, `${name} ${loc.header} overrides add_header without re-including security-headers.conf`);
      }
      if (loc.body.includes('try_files')) {
        assert.match(loc.body, /limit_except GET \{ deny all; \}/u, `${name} ${loc.header} must restrict static file methods to GET`);
      }
    }
  }
});

test('R090: styles.css handles <=375px viewports, policy nav links, focus-visible contrast, reduced motion, and cache-busted HTML links', async () => {
  const [css, indexHtml, privacyHtml, supportHtml] = await Promise.all([
    readFile(new URL('../website/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../website/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../website/privacy.html', import.meta.url), 'utf8'),
    readFile(new URL('../website/support.html', import.meta.url), 'utf8')
  ]);

  // Focus-visible includes select and high-contrast accent-dark ring
  assert.match(css, /a:focus-visible,button:focus-visible,summary:focus-visible,select:focus-visible\{outline:3px solid var\(--accent-dark\)/u);
  assert.match(css, /\.skip:focus/u);
  assert.match(css, /\.security-copy p\{[^}]*color:var\(--muted\)/u);

  // Overflow prevention & <=380px narrow layout hardening
  assert.match(css, /body\{[^}]*overflow-x:clip/u);
  assert.doesNotMatch(css, /\.mac-window\{[^}]*left:-4px/u);
  assert.match(css, /@media\(max-width:380px\)\{[^\n]*\.device-scene\{[^}]*overflow:hidden/u);
  assert.match(css, /@media\(max-width:380px\)\{[^\n]*\.feature-grid\{grid-template-columns:1fr\}/u);
  assert.match(css, /\.policy p,\.policy li\{[^}]*overflow-wrap:anywhere/u);

  // Reduced motion completeness
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{[^\n]*animation-duration:\.01ms!important[^\n]*transition-duration:\.01ms!important/u);

  // Policy/Support header single nav link stays visible on mobile viewports
  assert.match(css, /\.header nav>a:first-child:not\(:last-of-type\)\{display:none\}/u);
  assert.match(css, /\.header nav>a:nth-child\(2\):not\(:last-of-type\)\{display:none\}/u);

  /** @type {Array<[string, string, number]>} */
  const pageNavExpectations = [
    ['index.html', indexHtml, 3],
    ['privacy.html', privacyHtml, 1],
    ['support.html', supportHtml, 1]
  ];
  for (const [page, html, expectedNavLinks] of pageNavExpectations) {
    const window = new Window({ url: 'https://fixture.example/', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    window.document.write(html);
    assert.equal(window.document.querySelectorAll('header nav > a').length, expectedNavLinks, page);
    await window.happyDOM.close();
  }

  // Exact cache-busted styles.css?v=<16hex> across all HTML pages
  const cssHash = createHash('sha256').update(css).digest('hex').slice(0, 16);
  for (const [name, html] of [['index.html', indexHtml], ['privacy.html', privacyHtml], ['support.html', supportHtml]]) {
    assert.match(html, new RegExp(`href="styles\\.css\\?v=${cssHash}"`, 'u'), `${name} should reference styles.css?v=${cssHash}`);
  }
});
