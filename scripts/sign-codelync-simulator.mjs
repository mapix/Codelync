import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleId = 'com.learnings.codelync';
const applicationId = `SIMULATOR.${bundleId}`;
const defaultEntitlements = resolve(dirname(fileURLToPath(import.meta.url)), '../native/codelync-simulator.entitlements');

/** @param {Record<string, unknown>} info @param {Record<string, unknown>} entitlements */
export function validateSimulatorArtifact(info, entitlements) {
    if (info.CFBundleIdentifier !== bundleId) throw Error('Refusing an unrelated application artifact.');
    if (info.DTPlatformName !== 'iphonesimulator' || !Array.isArray(info.CFBundleSupportedPlatforms) || !info.CFBundleSupportedPlatforms.includes('iPhoneSimulator')) {
        throw Error('Refusing a non-simulator artifact.');
    }
    if (entitlements['application-identifier'] !== applicationId
        || !Array.isArray(entitlements['keychain-access-groups'])
        || entitlements['keychain-access-groups'].length !== 1
        || entitlements['keychain-access-groups'][0] !== applicationId) {
        throw Error('The simulator entitlements do not match the preserved Codelync identity.');
    }
}

/** @param {string} display @param {Record<string, unknown>} entitlements */
export function validateSignedArtifact(display, entitlements) {
    if (!display.split('\n').includes(`Identifier=${bundleId}`) || !/^Info\.plist entries=\d+$/m.test(display)) {
        throw Error('The signed artifact identifier or Info.plist binding is incorrect.');
    }
    const identifier = entitlements['application-identifier'], groups = entitlements['keychain-access-groups'];
    if (typeof identifier === 'string' && identifier.startsWith('SIMULATOR.')
        || Array.isArray(groups) && groups.some(group => typeof group === 'string' && group.startsWith('SIMULATOR.'))) {
        throw Error('Simulator identity belongs in the Mach-O section, not real code-signing entitlements.');
    }
}

/** @param {string} output */
export function simulatedEntitlementsXml(output) {
    const rows = output.split('\n').flatMap(line => {
        const match = line.match(/^\s*[0-9a-f]{8,16}\s+([0-9a-f\s]+)$/i);
        return match ? match[1].trim().split(/\s+/).filter(word => /^(?:[0-9a-f]{2}){1,4}$/i.test(word)) : [];
    });
    for (const reversed of [false, true]) {
        const hex = rows.map(word => reversed ? (word.match(/../g) ?? []).reverse().join('') : word).join('');
        const text = Buffer.from(hex, 'hex').toString('utf8');
        const start = text.indexOf('<?xml'), end = text.indexOf('</plist>');
        if (start >= 0 && end > start) return text.slice(start, end + 8);
    }
    throw Error('Missing simulated entitlements. Rebuild with the preserved CODE_SIGN_ENTITLEMENTS configuration.');
}

/** @param {string} binary @param {string[]} args @param {string | undefined} [input] */
function command(binary, args, input) {
    const value = execFileSync(binary, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
    return value;
}

/** @param {string} appPath */
function displaySignature(appPath) {
    const result = spawnSync('codesign', ['-d', '--verbose=4', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw Error('Unable to inspect the signed simulator artifact.');
    return result.stdout + result.stderr;
}

/** @param {string} appPath @param {string} [entitlementsPath] */
export async function signSimulatorArtifact(appPath, entitlementsPath = defaultEntitlements) {
    const app = resolve(appPath), entitlementsFile = resolve(entitlementsPath);
    const info = JSON.parse(command('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')]));
    const expected = JSON.parse(command('plutil', ['-convert', 'json', '-o', '-', entitlementsFile]));
    validateSimulatorArtifact(info, expected);
    const section = simulatedEntitlementsXml(command('xcrun', ['otool', '-arch', 'arm64', '-s', '__TEXT', '__entitlements', join(app, info.CFBundleExecutable)]));
    const simulated = JSON.parse(command('plutil', ['-convert', 'json', '-o', '-', '-'], section));
    validateSimulatorArtifact(info, simulated);
    const before = createHash('sha256').update(await readFile(join(app, 'main.jsbundle'))).digest('hex');
    command('codesign', ['--force', '--sign', '-', '--identifier', bundleId, '--timestamp=none', '--generate-entitlement-der', '--strip-disallowed-xattrs', app]);
    command('codesign', ['--verify', '--deep', '--strict', app]);
    const scratch = await mkdtemp(join(tmpdir(), 'codelync-sim-sign-'));
    try {
        const extractedPath = join(scratch, 'entitlements.plist');
        command('codesign', ['-d', '--xml', '--entitlements', extractedPath, app]);
        const bytes = await readFile(extractedPath).catch(() => Buffer.alloc(0));
        const actual = bytes.length ? JSON.parse(command('plutil', ['-convert', 'json', '-o', '-', extractedPath])) : {};
        const display = displaySignature(app);
        validateSignedArtifact(display, actual);
        const after = createHash('sha256').update(await readFile(join(app, 'main.jsbundle'))).digest('hex');
        if (before !== after) throw Error('Signing changed the compiled JavaScript payload.');
        return { bundleId, nativeBuild: info.CFBundleVersion, applicationIdentifier: applicationId,
            keychainAccessGroups: simulated['keychain-access-groups'], realEntitlements: actual, jsSha256: after, signatureVerified: true };
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 3) throw Error('Usage: node scripts/sign-codelync-simulator.mjs /absolute/path/Codelync.app');
        process.stdout.write(JSON.stringify(await signSimulatorArtifact(process.argv[2])) + '\n');
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
    }
}
