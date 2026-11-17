import test from 'node:test';
import assert from 'node:assert/strict';
import { readProfileProvisionedDevices, validateMobilePushArtifact } from '../scripts/verify-mobile-push.mjs';
/** @typedef {Record<string,any>} Value */
const fixture = () => (/** @type {Value} */ ({ info: { CFBundleIdentifier: 'com.learnings.codelync', DTPlatformName: 'iphoneos' }, entitlements: { 'aps-environment': 'development', 'application-identifier': 'TEAM.com.learnings.codelync', 'com.apple.developer.team-identifier': 'TEAM' }, profile: { Entitlements: { 'aps-environment': 'development', 'application-identifier': 'TEAM.com.learnings.codelync' }, TeamIdentifier: ['TEAM'], ExpirationDate: '2099-01-01', ProvisionedDevices: ['phone'] }, config: { extra: { app: { codelyncPushEnvironment: 'development' } } }, environment: 'development', device: 'phone' }));
test('requires signed entitlement, profile and embedded config to agree for the actual phone', () => {
  assert.equal(validateMobilePushArtifact(fixture()).signed, true);
  const wrongConfig = fixture(); wrongConfig.config.extra.app.codelyncPushEnvironment = 'production'; assert.throws(() => validateMobilePushArtifact(wrongConfig), /mismatch/);
  const wrongProfile = fixture(); wrongProfile.profile.Entitlements['application-identifier'] = 'TEAM.*'; assert.throws(() => validateMobilePushArtifact(wrongProfile), /topic/);
  const missingDevice = fixture(); missingDevice.device = 'other-phone'; assert.throws(() => validateMobilePushArtifact(missingDevice), /device-missing/);
  const simulator = fixture(); simulator.info.DTPlatformName = 'iphonesimulator'; assert.throws(() => validateMobilePushArtifact(simulator), /device-artifact/);
  const foreignApp = fixture(); foreignApp.info.CFBundleIdentifier = 'com.example.unrelated'; assert.throws(() => validateMobilePushArtifact(foreignApp), /codelync-device-artifact/);
});
test('App Store production validation accepts no device list while keeping signing and config gates', () => {
  const appStore = fixture(); appStore.environment = 'production'; appStore.entitlements['aps-environment'] = 'production';
  appStore.profile.Entitlements['aps-environment'] = 'production'; appStore.config.extra.app.codelyncPushEnvironment = 'production';
  delete appStore.device; delete appStore.profile.ProvisionedDevices;
  appStore.profile.ProvisionedDevices = readProfileProvisionedDevices('<plist><dict><key>Entitlements</key><dict/></dict></plist>', () => { throw Error('Missing optional field must not be extracted'); });
  assert.equal(validateMobilePushArtifact(appStore).signed, true);
  const badEntitlement = structuredClone(appStore); badEntitlement.entitlements['aps-environment'] = 'development';
  assert.throws(() => validateMobilePushArtifact(badEntitlement), /mismatch/);
  const badConfig = structuredClone(appStore); badConfig.config.extra.app.codelyncPushEnvironment = 'development';
  assert.throws(() => validateMobilePushArtifact(badConfig), /mismatch/);
  const badTeam = structuredClone(appStore); badTeam.entitlements['com.apple.developer.team-identifier'] = 'OTHER';
  assert.throws(() => validateMobilePushArtifact(badTeam), /team-topic/);
});
test('private device validation requires an exact array entry and does not swallow a malformed present list', () => {
  const missing = fixture(); delete missing.profile.ProvisionedDevices;
  assert.throws(() => validateMobilePushArtifact(missing), /device-missing/);
  const invalid = fixture(); invalid.profile.ProvisionedDevices = 'phone';
  assert.throws(() => validateMobilePushArtifact(invalid), /device-missing/);
  const present = '<plist><dict><key>ProvisionedDevices</key><array/></dict></plist>';
  assert.deepEqual(readProfileProvisionedDevices(present, () => '["phone"]'), ['phone']);
  assert.throws(() => readProfileProvisionedDevices(present, () => '{'), SyntaxError);
  assert.throws(() => readProfileProvisionedDevices(present, () => '"phone"'), /device-list-invalid/);
});
