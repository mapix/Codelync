import assert from 'node:assert/strict';
import test from 'node:test';
import { simulatedEntitlementsXml, validateSignedArtifact, validateSimulatorArtifact } from '../scripts/sign-codelight-simulator.mjs';

const info = { CFBundleIdentifier: 'com.learnings.codelight', DTPlatformName: 'iphonesimulator', CFBundleSupportedPlatforms: ['iPhoneSimulator'] };
const entitlements = { 'application-identifier': 'SIMULATOR.com.learnings.codelight', 'keychain-access-groups': ['SIMULATOR.com.learnings.codelight'] };
test('accepts the preserved simulator identity', () => validateSimulatorArtifact(info, entitlements));
test('rejects physical-device and unrelated artifacts before signing', () => {
    assert.throws(() => validateSimulatorArtifact({ ...info, DTPlatformName: 'iphoneos', CFBundleSupportedPlatforms: ['iPhoneOS'] }, entitlements), /non-simulator/);
    assert.throws(() => validateSimulatorArtifact({ ...info, CFBundleIdentifier: 'other.application' }, entitlements), /unrelated/);
});
test('rejects missing or expanded Keychain groups', () => {
    assert.throws(() => validateSimulatorArtifact(info, {}), /preserved/);
    assert.throws(() => validateSimulatorArtifact(info, { ...entitlements, 'keychain-access-groups': [...entitlements['keychain-access-groups'], 'another.group'] }), /preserved/);
});
test('rejects linker-only and incorrectly bound signing results', () => {
    assert.throws(() => validateSignedArtifact('Identifier=Happydev\nInfo.plist=not bound', entitlements), /incorrect/);
    assert.throws(() => validateSignedArtifact('Identifier=com.learnings.codelight\nInfo.plist=not bound', entitlements), /incorrect/);
    assert.throws(() => validateSignedArtifact('Identifier=com.learnings.codelight\nInfo.plist entries=42', entitlements), /Mach-O/);
    validateSignedArtifact('Identifier=com.learnings.codelight\nInfo.plist entries=42', {});
});
test('extracts the simulated linker section and refuses its absence', () => {
    const xml = '<?xml version="1.0"?><plist><dict></dict></plist>';
    const padded = Buffer.concat([Buffer.from(xml), Buffer.alloc(4 - Buffer.byteLength(xml) % 4)]);
    const words = padded.toString('hex').match(/.{8}/g) ?? [];
    for (const reversed of [false, true]) {
        const row = words.map(word => reversed ? (word.match(/../g) ?? []).reverse().join('') : word).join(' ');
        assert.equal(simulatedEntitlementsXml('0000000100000000 '+row), xml);
    }
    const tail = (Buffer.from(xml).toString('hex').match(/.{2,8}/g) ?? []).map(word => (word.match(/../g) ?? []).reverse().join('')).join(' ');
    assert.equal(simulatedEntitlementsXml('0000000100000000 '+tail), xml);
    assert.throws(() => simulatedEntitlementsXml('binary:'), /Missing simulated entitlements/);
});
