import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMobilePushArtifact } from './verify-mobile-push.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(arg => arg !== '--');
const flags = new Map();
for (let index = 0; index < args.length; index++) {
  const key = args[index];
  if (!['--device', '--simulator', '--team', '--derived-data', '--dry-run', '--generic', '--push-environment', '--allow-provisioning-updates', '--profile-name'].includes(key)) throw Error(`Unknown build option: ${key}`);
  if (key === '--dry-run' || key === '--generic' || key === '--allow-provisioning-updates') flags.set(key, true);
  else { const value = args[++index]; if (!value || value.startsWith('--')) throw Error(`${key} requires a value`); flags.set(key, value); }
}
const device = flags.get('--device'), simulator = flags.get('--simulator');
const pushEnvironment = flags.get('--push-environment');
if (pushEnvironment && !['development', 'production'].includes(pushEnvironment)) throw Error('Push environment must be development or production.');
if (simulator && pushEnvironment) throw Error('APNs device builds require a physical iPhone.');
if (simulator && flags.has('--profile-name')) throw Error('Provisioning profiles are only used for device builds.');
if ((!device && !simulator) || (device && simulator)) throw Error('Choose exactly one explicit --device ID or --simulator ID.');
if (device && !flags.get('--team')) throw Error('Device builds require an explicit --team ID.');
const target = device ? 'device' : 'simulator';
const derived = resolve(flags.get('--derived-data') ?? join(root, 'evidence/private/mobile-' + target));
const entitlements = join(root, 'native', simulator ? 'codelync-simulator.entitlements' : pushEnvironment ? `codelync-push-${pushEnvironment}.entitlements` : 'codelync-development.entitlements');
await access(entitlements);
const buildArgs = ['-workspace', 'ios/Codelync.xcworkspace', '-scheme', 'Codelync', '-configuration', 'Release',
  '-destination', device && flags.has('--generic') ? 'generic/platform=iOS' : simulator ? `platform=iOS Simulator,id=${simulator}` : `id=${device}`, '-derivedDataPath', derived,
  'CODE_SIGN_ENTITLEMENTS=' + entitlements, 'CODE_SIGN_STYLE=' + (flags.has('--profile-name') ? 'Manual' : 'Automatic'),
  ...(flags.has('--profile-name') ? ['PROVISIONING_PROFILE_SPECIFIER=' + flags.get('--profile-name')] : []),
  ...(device ? ['DEVELOPMENT_TEAM=' + flags.get('--team'), 'CODE_SIGN_IDENTITY=' + (pushEnvironment === 'production' ? 'Apple Distribution' : 'Apple Development')] : ['CODE_SIGN_IDENTITY=-', 'ONLY_ACTIVE_ARCH=YES']),
  ...(flags.has('--allow-provisioning-updates') ? ['-allowProvisioningUpdates'] : []), '-jobs', '8', 'build'];
if (flags.has('--dry-run')) console.log(JSON.stringify({ cwd: join(root, 'apps/mobile'), args: buildArgs, entitlements, pushEnvironment: pushEnvironment ?? null }));
else {
  await mkdir(derived, { recursive: true });
  /** @type {NodeJS.ProcessEnv} */ const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, NODE_BINARY: process.execPath,
    CODELYNC_NONINVASIVE_LOCAL: '1', EXPO_NO_DOTENV: '1' };
  delete env.EXPO_PUBLIC_CODELYNC_SERVER_URL; delete env.EXPO_PUBLIC_SERVER_URL;
  if (pushEnvironment) env.CODELYNC_APNS_ENVIRONMENT = pushEnvironment;
  else delete env.CODELYNC_APNS_ENVIRONMENT;
  // 迁移后的签名文件必须从新 repo 解析；错误退出码直接传播，不能被 tail/rg 的成功状态掩盖。
  const child = spawn('xcodebuild', buildArgs, { cwd: join(root, 'apps/mobile'), env, stdio: 'inherit' });
  process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)); });
  if (process.exitCode === 0 && pushEnvironment) console.log(JSON.stringify(await verifyMobilePushArtifact(join(derived, 'Build/Products/Release-iphoneos/Codelync.app'), pushEnvironment, device)));
}
