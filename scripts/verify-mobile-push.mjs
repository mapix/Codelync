import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
/** @typedef {Record<string,any>} Value */
/** @param {Value} input */
export function validateMobilePushArtifact({ info, entitlements, profile, config, environment, device }) {
  if (!['development', 'production'].includes(environment)) throw Error('invalid-push-environment');
  if (info.CFBundleIdentifier !== 'com.learnings.codelync' || info.DTPlatformName !== 'iphoneos') throw Error('push-requires-codelync-device-artifact');
  if (entitlements['aps-environment'] !== environment || profile.Entitlements?.['aps-environment'] !== environment || config.extra?.app?.codelyncPushEnvironment !== environment) throw Error('push-signing-profile-config-mismatch');
  const team = profile.TeamIdentifier?.[0];
  if (!team || entitlements['com.apple.developer.team-identifier'] !== team || entitlements['application-identifier'] !== team + '.com.learnings.codelync' || profile.Entitlements['application-identifier'] !== team + '.com.learnings.codelync') throw Error('push-team-topic-mismatch');
  const expires = new Date(profile.ExpirationDate).getTime();
  if (!Number.isFinite(expires) || expires <= Date.now()) throw Error('push-profile-expired');
  if (device && (!Array.isArray(profile.ProvisionedDevices) || !profile.ProvisionedDevices.includes(device))) throw Error('push-profile-device-missing');
  return { signed: true, environment, profileMatches: true, embeddedConfigMatches: true };
}
/** @param {string} executable @param {string[]} args @param {string|Buffer} [input] */
function run(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error('push-artifact-inspection-failed');
  return result.stdout;
}
/** @param {string|Buffer} data */
function plist(data) { return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], data)); }
/** App Store profiles have no device list; a present list must still be readable.
 * @param {string} profileXml @param {()=>string} extract */
export function readProfileProvisionedDevices(profileXml, extract) {
  if (!/<key>\s*ProvisionedDevices\s*<\/key>/u.test(profileXml)) return undefined;
  const devices = JSON.parse(extract());
  if (!Array.isArray(devices) || !devices.every(device => typeof device === 'string')) throw Error('push-profile-device-list-invalid');
  return devices;
}
/** @param {string} app @param {string} environment @param {string} [device] */
export async function verifyMobilePushArtifact(app, environment, device) {
  const info = plist(await readFile(join(app, 'Info.plist')));
  const entitlements = plist(run('codesign', ['-d', '--entitlements', ':-', app]));
  const profileXml = run('security', ['cms', '-D', '-i', join(app, 'embedded.mobileprovision')]);
  // Whole-profile JSON conversion rejects Apple's date/data values. Extract
  // only the signing facts needed here; certificate blobs never enter output.
  const profile = {
    Entitlements: JSON.parse(run('plutil', ['-extract', 'Entitlements', 'json', '-o', '-', '-'], profileXml)),
    TeamIdentifier: JSON.parse(run('plutil', ['-extract', 'TeamIdentifier', 'json', '-o', '-', '-'], profileXml)),
    ExpirationDate: run('plutil', ['-extract', 'ExpirationDate', 'raw', '-o', '-', '-'], profileXml).trim(),
    ProvisionedDevices: readProfileProvisionedDevices(profileXml, () => run('plutil', ['-extract', 'ProvisionedDevices', 'json', '-o', '-', '-'], profileXml)),
  };
  const config = JSON.parse(await readFile(join(app, 'EXConstants.bundle', 'app.config'), 'utf8'));
  return validateMobilePushArtifact({ info, entitlements, profile, config, environment, device });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await verifyMobilePushArtifact(resolve(process.argv[2]), process.argv[3], process.argv[4]))); }
  catch (error) { console.error(error instanceof Error ? error.message : 'push-artifact-inspection-failed'); process.exitCode = 1; }
}
