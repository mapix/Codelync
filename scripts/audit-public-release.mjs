import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const UNTRANSLATED_SWIFT_UI_LITERALS = new Set(['Codelync', 'https://relay.example.com', 'wss://media.example.com']);

/** Validate `website/testflight.json` against `website/schema/testflight.schema.json`.
 * @param {string} [rootDir]
 * @returns {Promise<Record<string, any>>} */
export async function validatePublicTestflightManifest(rootDir = root) {
  const [schemaRaw, betaRaw] = await Promise.all([
    readFile(join(rootDir, 'website/schema/testflight.schema.json'), 'utf8'),
    readFile(join(rootDir, 'website/testflight.json'), 'utf8')
  ]);
  const schema = JSON.parse(schemaRaw);
  const beta = /** @type {Record<string, any>} */ (JSON.parse(betaRaw));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const installFormats = /** @type {(validator: import('ajv').default) => void} */ (/** @type {unknown} */ (addFormats));
  installFormats(/** @type {import('ajv').default} */ (/** @type {unknown} */ (ajv)));
  const validate = ajv.compile(schema);
  if (!validate(beta)) {
    throw Error(`Invalid website/testflight.json metadata against website/schema/testflight.schema.json: ${ajv.errorsText(validate.errors)}`);
  }
  return beta;
}

/** Extract user-facing localization keys referenced by `apps/mac/Codelync.swift`.
 * @param {string} swiftSource */
export function extractSwiftLocalizationKeys(swiftSource) {
  const body = swiftSource.replace(/#if DEBUG[\s\S]*?#endif/gu, '');
  /** @type {Set<string>} */
  const keys = new Set();
  for (const pattern of [
    /NSLocalizedString\("([^"\n\\]+)"/gu,
    /(?:^|[^A-Za-z0-9_])(?:Text|Button|Label|Toggle|Section|Picker|TextField|SecureField|Link|DisclosureGroup|LabeledContent)\("([^"\n\\]+)"/gu,
    /(?:RateValue|ByteTotals|SmallMetric)\([^)]*(?:label|title):\s*"([^"\n\\]+)"/gu
  ]) {
    for (const match of body.matchAll(pattern)) {
      if (!UNTRANSLATED_SWIFT_UI_LITERALS.has(match[1])) keys.add(match[1]);
    }
  }
  const nonUiTokens = new Set([
    'codex', 'antigravity', 'claude-desktop', 'local', 'cloudflare', 'relay',
    'ready', 'starting', 'reconnecting', 'unverified', 'unavailable',
    'public-connection', 'push-device-not-registered', 'push-environment-mismatch',
    'source-subscriptions-save-failed', 'ok', 'code', 'phase', ''
  ]);
  for (const match of body.matchAll(/(?:static func label\([\s\S]*?\n\s*\}|enum ConnectionStatus[\s\S]*?\n\}|var publicStatus:[\s\S]*?\n\s*\}|LocalizedStringKey\([^\n]+\)|(?:status|sourcesError|channelsError|accessError|desktopError|notificationsError|operationError)\s*=\s*[^\n]+)/gu)) {
    for (const quoted of match[0].matchAll(/"((?:[^"\n\\]|\\.)*)"/gu)) {
      const value = quoted[1];
      if (!nonUiTokens.has(value) && !UNTRANSLATED_SWIFT_UI_LITERALS.has(value)) {
        keys.add(value);
      }
    }
  }
  return [...keys].sort();
}

/** Verify full EN / zh-Hans / ja parity between `apps/mac/translations.mjs` and `apps/mac/Codelync.swift`.
 * @param {string} [rootDir] */
export async function validateMacLocalizationParity(rootDir = root) {
  const [swiftSource, translationsModule] = await Promise.all([
    readFile(join(rootDir, 'apps/mac/Codelync.swift'), 'utf8'),
    import(pathToFileURL(join(rootDir, 'apps/mac/translations.mjs')).href)
  ]);
  const { macTranslations, macLocalNetworkDescriptions } = translationsModule;
  const enKeys = Object.keys(macTranslations.en).sort();
  for (const locale of ['en', 'zh-Hans', 'ja']) {
    const table = macTranslations[locale];
    if (!table || typeof table !== 'object') throw Error(`Missing Mac localization dictionary: ${locale}.`);
    const localeKeys = Object.keys(table).sort();
    if (localeKeys.length !== enKeys.length || localeKeys.some((key, index) => key !== enKeys[index])) {
      throw Error(`Mac localization keys for ${locale} do not match en.`);
    }
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string' || !value.trim()) throw Error(`Empty Mac translation for ${locale}.${key}.`);
    }
    if (typeof macLocalNetworkDescriptions?.[locale] !== 'string' || !macLocalNetworkDescriptions[locale].trim()) {
      throw Error(`Missing NSLocalNetworkUsageDescription for ${locale}.`);
    }
  }
  const swiftKeys = extractSwiftLocalizationKeys(swiftSource);
  const missingFromTranslations = swiftKeys.filter(key => !Object.hasOwn(macTranslations.en, key));
  if (missingFromTranslations.length) {
    throw Error(`Codelync.swift UI keys missing from apps/mac/translations.mjs: ${missingFromTranslations.join(', ')}`);
  }
  return { keyCount: enKeys.length, swiftKeysChecked: swiftKeys.length };
}

/** Verify advisory 1247710 (GHSA-fc5q-39xc-vjpf, picomatch <=4.0.7 with no upstream release yet)
 * is strictly confined to apps/mobile Expo CLI / Metro build-time bundler paths and absent from shipped runtimes.
 * @param {Record<string, any>} row */
export function isExpoBuildOnlyPicomatchAdvisory(row) {
  if (!row || row.id !== 1247710 || row.module_name !== 'picomatch') return false;
  if (!Array.isArray(row.findings) || row.findings.length === 0) return false;
  const allPaths = row.findings.flatMap(finding => Array.isArray(finding?.paths) ? finding.paths : []);
  if (allPaths.length === 0) return false;
  return allPaths.every(p => typeof p === 'string' && /^apps__mobile>expo>@(?:expo\/cli|expo\/metro)(?:>|$)/u.test(p));
}

/** Run the full public release dependency, TestFlight schema, and Mac localization gate.
 * @param {string} [rootDir] */
export async function runPublicReleaseAudit(rootDir = root) {
  const beta = await validatePublicTestflightManifest(rootDir);
  const macLocalization = await validateMacLocalizationParity(rootDir);
  let stdout;
  try { stdout = (await run('pnpm', ['audit', '--prod', '--json'], { cwd: rootDir, maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch (error) {
    const result = /** @type {Error & {stdout?:string}} */ (error);
    if (!result.stdout) throw error;
    stdout = result.stdout;
  }
  const audit = JSON.parse(stdout);
  if (!audit.metadata?.vulnerabilities || audit.error || !audit.advisories) throw Error('Dependency audit did not return a complete report.');
  const advisories = /** @type {Record<string,any>[]} */ (Object.values(audit.advisories));
  const patchedIds = new Set([1239765, 1239766]);
  const patched = advisories.filter(row => patchedIds.has(row.id) && row.module_name === 'image-size');
  if (patched.length) {
    // 只允许这两条已回归的容器死循环告警；保留扫描原始计数，其他高危不因同包名被放行。
    const workspace = await readFile(join(rootDir, 'pnpm-workspace.yaml'), 'utf8');
    if (!workspace.includes('image-size@1.2.1:') || !workspace.includes('patches/image-size@1.2.1.patch')) throw Error('Required image parser patch is not configured.');
    await run(process.execPath, ['--test', 'test/image-container-security.test.mjs'], { cwd: rootDir });
  }
  const buildOnly = advisories.filter(isExpoBuildOnlyPicomatchAdvisory);
  const blocked = advisories.filter(row => ['high', 'critical'].includes(row.severity) && !patched.includes(row) && !buildOnly.includes(row));
  const report = {
    generatedAt: new Date().toISOString(),
    rawCounts: audit.metadata.vulnerabilities,
    patchedContainerAdvisories: patched.map(row => ({ id: row.id, url: row.url, regression: 'passed' })),
    buildOnlyAdvisories: buildOnly.map(row => ({
      id: row.id,
      module: row.module_name,
      url: row.url,
      reachability: 'expo-metro-build-only-not-shipped',
      paths: row.findings.flatMap((/** @type {any} */ f) => f.paths)
    })),
    testflightManifest: { status: beta.status, version: beta.version, build: beta.build, valid: true },
    macLocalization,
    blocked: blocked.map(row => ({ id: row.id, module: row.module_name, severity: row.severity, url: row.url })),
    remaining: advisories.filter(row => !patched.includes(row)).map(row => ({ id: row.id, module: row.module_name, severity: row.severity, url: row.url })),
  };
  await mkdir(join(rootDir, 'evidence/private'), { recursive: true, mode: 0o700 });
  await writeFile(join(rootDir, 'evidence/private/public-release-dependency-gate.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (blocked.length) throw Error('Unreviewed high/critical dependency advisories block publication.');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runPublicReleaseAudit();
}
