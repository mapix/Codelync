import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyMobilePushArtifact } from './verify-mobile-push.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BOOLEAN_FLAGS = new Set(['--dry-run', '--generic', '--allow-provisioning-updates']);
const VALUE_FLAGS = new Set([
  '--platform',
  '--configuration',
  '--device',
  '--simulator',
  '--team',
  '--derived-data',
  '--push-environment',
  '--profile-name',
]);
const IOS_ONLY_FLAGS = [
  '--device',
  '--simulator',
  '--team',
  '--derived-data',
  '--generic',
  '--push-environment',
  '--allow-provisioning-updates',
  '--profile-name',
];

/**
 * @typedef {{
 *   platform: 'ios',
 *   configuration: 'Debug' | 'Release',
 *   dryRun: boolean,
 *   device: string | undefined,
 *   simulator: string | undefined,
 *   team: string | undefined,
 *   derivedData: string | undefined,
 *   generic: boolean,
 *   pushEnvironment: 'development' | 'production' | undefined,
 *   allowProvisioningUpdates: boolean,
 *   profileName: string | undefined,
 * }} ParsedIosArgs
 */

/**
 * @typedef {{
 *   platform: 'android',
 *   configuration: 'Debug' | 'Release',
 *   dryRun: boolean,
 * }} ParsedAndroidArgs
 */

/** Parse and validate CLI arguments for iOS and Android mobile builds.
 * @param {string[]} rawArgs
 * @returns {ParsedIosArgs | ParsedAndroidArgs} */
export function parseMobileBuildArgs(rawArgs) {
  const args = rawArgs.filter(arg => arg !== '--');
  /** @type {Map<string, string | boolean>} */
  const flags = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!BOOLEAN_FLAGS.has(key) && !VALUE_FLAGS.has(key)) {
      throw Error(`Unknown build option: ${key}`);
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, true);
    } else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error(`${key} requires a value`);
      flags.set(key, value);
    }
  }

  const rawPlatform = flags.get('--platform');
  const platform = typeof rawPlatform === 'string' ? rawPlatform.toLowerCase() : 'ios';
  if (platform !== 'ios' && platform !== 'android') {
    throw Error('Platform must be ios or android.');
  }

  const dryRun = Boolean(flags.get('--dry-run'));
  const rawConfig = flags.get('--configuration');

  if (platform === 'android') {
    for (const iosFlag of IOS_ONLY_FLAGS) {
      if (flags.has(iosFlag)) throw Error(`Option ${iosFlag} is only supported for iOS builds.`);
    }
    const normalizedConfig = typeof rawConfig === 'string' ? rawConfig.toLowerCase() : 'release';
    if (normalizedConfig !== 'debug' && normalizedConfig !== 'release') {
      throw Error('Android configuration must be Debug or Release.');
    }
    return {
      platform: 'android',
      configuration: normalizedConfig === 'debug' ? 'Debug' : 'Release',
      dryRun,
    };
  }

  const iosConfigLower = typeof rawConfig === 'string' ? rawConfig.toLowerCase() : 'release';
  if (iosConfigLower !== 'debug' && iosConfigLower !== 'release') {
    throw Error('iOS configuration must be Debug or Release.');
  }
  const device = /** @type {string | undefined} */ (flags.get('--device'));
  const simulator = /** @type {string | undefined} */ (flags.get('--simulator'));
  const pushEnvironment = /** @type {string | undefined} */ (flags.get('--push-environment'));
  if (pushEnvironment && pushEnvironment !== 'development' && pushEnvironment !== 'production') {
    throw Error('Push environment must be development or production.');
  }
  if (simulator && pushEnvironment) throw Error('APNs device builds require a physical iPhone.');
  if (simulator && flags.has('--profile-name')) throw Error('Provisioning profiles are only used for device builds.');
  if ((!device && !simulator) || (device && simulator)) {
    throw Error('Choose exactly one explicit --device ID or --simulator ID.');
  }
  if (device && !flags.get('--team')) throw Error('Device builds require an explicit --team ID.');

  return {
    platform: 'ios',
    configuration: iosConfigLower === 'debug' ? 'Debug' : 'Release',
    dryRun,
    device,
    simulator,
    team: /** @type {string | undefined} */ (flags.get('--team')),
    derivedData: /** @type {string | undefined} */ (flags.get('--derived-data')),
    generic: Boolean(flags.get('--generic')),
    pushEnvironment: /** @type {'development' | 'production' | undefined} */ (pushEnvironment),
    allowProvisioningUpdates: Boolean(flags.get('--allow-provisioning-updates')),
    profileName: /** @type {string | undefined} */ (flags.get('--profile-name')),
  };
}

/** Resolve a Node >= 24 executable path without hardcoded home literals.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} */
export function resolveNode24Binary(env = process.env) {
  /** @type {string[]} */
  const candidates = [];
  if (env.CODELYNC_NODE_BINARY) candidates.push(env.CODELYNC_NODE_BINARY);
  if (Number(process.versions.node.split('.')[0]) >= 24) candidates.push(process.execPath);

  const nvmVersionsDir = join(env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node');
  if (existsSync(nvmVersionsDir)) {
    const entries = readdirSync(nvmVersionsDir)
      .filter(entry => {
        const match = /^v(\d+)\./u.exec(entry);
        return Boolean(match && Number(match[1]) >= 24);
      })
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const entry of entries) {
      candidates.push(join(nvmVersionsDir, entry, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
    }
  }
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node');

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (candidate === process.execPath && Number(process.versions.node.split('.')[0]) >= 24) {
      return candidate;
    }
    const probe = spawnSync(candidate, ['-p', 'process.versions.node'], { encoding: 'utf8' });
    if (probe.status === 0 && Number((probe.stdout || '').trim().split('.')[0]) >= 24) {
      return candidate;
    }
  }
  throw Error('Android builds require Node 24 or newer.');
}

/** Discover JDK 21+ JAVA_HOME across explicit env, Android Studio JBR, and system locations.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} */
export function resolveJavaHome(env = process.env) {
  const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
  /** @type {string[]} */
  const candidates = [];
  if (env.JAVA_HOME) candidates.push(env.JAVA_HOME);
  candidates.push(
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    join(homedir(), 'Applications', 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home'),
  );
  if (process.platform === 'darwin' && existsSync('/usr/libexec/java_home')) {
    for (const args of [['-v', '21'], []]) {
      const probe = spawnSync('/usr/libexec/java_home', args, { encoding: 'utf8' });
      if (probe.status === 0 && probe.stdout.trim()) candidates.push(probe.stdout.trim());
    }
  }
  candidates.push(
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/usr/lib/jvm/java-21-openjdk-arm64',
    '/usr/lib/jvm/java-21-openjdk-amd64',
    '/usr/lib/jvm/java-21-openjdk',
  );
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'bin', javaExe))) return candidate;
  }
  throw Error('Unable to locate JDK (JAVA_HOME). Set JAVA_HOME to JDK 21 (for example Android Studio JBR).');
}

/** Discover ANDROID_HOME / ANDROID_SDK_ROOT across explicit env and standard OS locations.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} */
export function resolveAndroidHome(env = process.env) {
  const defaultSdk = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Android', 'sdk')
    : process.platform === 'win32'
      ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
      : join(homedir(), 'Android', 'Sdk');
  for (const candidate of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, defaultSdk]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw Error('Unable to locate Android SDK. Set ANDROID_HOME or ANDROID_SDK_ROOT.');
}

/** Resolve all Android build toolchain locations.
 * @param {NodeJS.ProcessEnv} [env] */
export function resolveAndroidToolchain(env = process.env) {
  return {
    nodeBinary: resolveNode24Binary(env),
    javaHome: resolveJavaHome(env),
    androidHome: resolveAndroidHome(env),
  };
}

/** Derive a deterministic 32-char hex keystore password from a binary seed buffer.
 * @param {Buffer} seedBytes
 * @returns {string} */
export function deriveSigningPassword(seedBytes) {
  return createHash('sha256').update(seedBytes).digest('hex').slice(0, 32);
}

/** Resolve explicit CODELYNC_UPLOAD_* release credentials or lazily generate/reuse an untracked keystore in .signing/.
 * @param {{ androidDir: string, javaHome: string, env?: NodeJS.ProcessEnv, cwd?: string, workspaceRoot?: string }} options */
export async function ensureAndroidReleaseSigning({
  androidDir,
  javaHome,
  env = process.env,
  cwd = process.cwd(),
  workspaceRoot = root,
}) {
  const explicitStore = env.CODELYNC_UPLOAD_STORE_FILE?.trim();
  if (explicitStore) {
    const storePassword = env.CODELYNC_UPLOAD_STORE_PASSWORD;
    if (!storePassword) {
      throw Error('CODELYNC_UPLOAD_STORE_FILE requires CODELYNC_UPLOAD_STORE_PASSWORD.');
    }
    const keyAlias = env.CODELYNC_UPLOAD_KEY_ALIAS?.trim() || 'codelync-release';
    const keyPassword = env.CODELYNC_UPLOAD_KEY_PASSWORD || storePassword;
    const searchBases = [env.INIT_CWD || cwd, workspaceRoot, androidDir];
    const candidates = isAbsolute(explicitStore)
      ? [explicitStore]
      : searchBases.map(base => resolve(base, explicitStore));
    const resolvedStore = candidates.find(candidate => existsSync(candidate));
    if (!resolvedStore) {
      throw Error(`CODELYNC_UPLOAD_STORE_FILE does not exist: ${explicitStore}`);
    }
    return {
      mode: /** @type {const} */ ('explicit'),
      storeFile: resolvedStore,
      storePassword,
      keyAlias,
      keyPassword,
    };
  }

  const signingDir = join(androidDir, '.signing');
  const keystorePath = join(signingDir, 'codelync-release.keystore');
  const seedPath = join(signingDir, 'credentials.key');
  const keyAlias = 'codelync-release';

  if (!existsSync(keystorePath) || !existsSync(seedPath)) {
    await mkdir(signingDir, { recursive: true, mode: 0o700 });
    await rm(keystorePath, { force: true });
    const seed = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x00]), randomBytes(28)]);
    await writeFile(seedPath, seed, { mode: 0o600 });
    const password = deriveSigningPassword(seed);
    const keytool = join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
    await execFileAsync(keytool, [
      '-genkeypair',
      '-noprompt',
      '-storetype',
      'PKCS12',
      '-keystore',
      keystorePath,
      '-alias',
      keyAlias,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-storepass',
      password,
      '-keypass',
      password,
      '-dname',
      'CN=Codelync Local Release, OU=Mobile, O=Codelync, C=US',
    ]);
    await chmod(keystorePath, 0o600);
  }

  const seedBytes = await readFile(seedPath);
  const password = deriveSigningPassword(seedBytes);
  return {
    mode: /** @type {const} */ ('local-generated'),
    storeFile: keystorePath,
    storePassword: password,
    keyAlias,
    keyPassword: password,
  };
}

/** Construct a sanitized child environment for Android Gradle invocations.
 * @param {{
 *   baseEnv?: NodeJS.ProcessEnv,
 *   configuration: 'Debug' | 'Release',
 *   nodeBinary: string,
 *   javaHome: string,
 *   androidHome: string,
 *   signing?: { storeFile: string, storePassword: string, keyAlias: string, keyPassword: string }
 * }} options
 * @returns {NodeJS.ProcessEnv} */
export function buildAndroidGradleEnv({
  baseEnv = process.env,
  configuration,
  nodeBinary,
  javaHome,
  androidHome,
  signing,
}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...baseEnv,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    NODE_BINARY: nodeBinary,
    PATH: [dirname(nodeBinary), join(javaHome, 'bin'), join(androidHome, 'platform-tools'), baseEnv.PATH]
      .filter(Boolean)
      .join(delimiter),
    APP_ENV: configuration === 'Release' ? 'production' : (baseEnv.APP_ENV || 'development'),
    CODELYNC_NONINVASIVE_LOCAL: '1',
    EXPO_NO_DOTENV: '1',
  };
  delete env.EXPO_PUBLIC_CODELYNC_SERVER_URL;
  delete env.EXPO_PUBLIC_SERVER_URL;
  delete env.CODELYNC_APNS_ENVIRONMENT;
  if (signing) {
    env.CODELYNC_UPLOAD_STORE_FILE = signing.storeFile;
    env.CODELYNC_UPLOAD_STORE_PASSWORD = signing.storePassword;
    env.CODELYNC_UPLOAD_KEY_ALIAS = signing.keyAlias;
    env.CODELYNC_UPLOAD_KEY_PASSWORD = signing.keyPassword;
  }
  return env;
}

/** Execute or dry-run the requested iOS or Android mobile build.
 * @param {string[]} [rawArgs] */
export async function runMobileBuild(rawArgs = process.argv.slice(2)) {
  const parsed = parseMobileBuildArgs(rawArgs);

  if (parsed.platform === 'android') {
    const androidDir = join(root, 'apps/mobile/android');
    const gradlew = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const variantDir = parsed.configuration.toLowerCase();
    const apkPath = join(androidDir, 'app', 'build', 'outputs', 'apk', variantDir, `app-${variantDir}.apk`);
    const gradleTask = parsed.configuration === 'Release' ? 'assembleRelease' : 'assembleDebug';
    const toolchain = resolveAndroidToolchain(process.env);
    const gradleArgs = [gradleTask, `-PreactNativeNodeExecutable=${toolchain.nodeBinary}`];
    const signingMode = parsed.configuration === 'Release'
      ? (process.env.CODELYNC_UPLOAD_STORE_FILE?.trim() ? 'explicit' : 'local-generated')
      : 'debug';

    if (parsed.dryRun) {
      console.log(JSON.stringify({
        platform: 'android',
        configuration: parsed.configuration,
        cwd: androidDir,
        command: gradlew,
        args: gradleArgs,
        appEnv: parsed.configuration === 'Release' ? 'production' : (process.env.APP_ENV || 'development'),
        apkPath,
        javaHome: toolchain.javaHome,
        androidHome: toolchain.androidHome,
        nodeBinary: toolchain.nodeBinary,
        signingMode,
      }));
      return;
    }

    await access(gradlew).catch(() => {
      throw Error('apps/mobile/android/gradlew is missing; run pnpm --filter @codelync/mobile prebuild:android first.');
    });
    const signing = parsed.configuration === 'Release'
      ? await ensureAndroidReleaseSigning({ androidDir, javaHome: toolchain.javaHome, env: process.env })
      : undefined;
    const env = buildAndroidGradleEnv({
      baseEnv: process.env,
      configuration: parsed.configuration,
      nodeBinary: toolchain.nodeBinary,
      javaHome: toolchain.javaHome,
      androidHome: toolchain.androidHome,
      signing,
    });
    const child = spawn(gradlew, gradleArgs, { cwd: androidDir, env, stdio: 'inherit' });
    const exitCode = await /** @type {Promise<number>} */ (new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', code => done(code ?? 1));
    }));
    process.exitCode = exitCode;
    if (exitCode === 0) {
      const apkInfo = await stat(apkPath).catch(() => null);
      if (!apkInfo || !apkInfo.isFile() || apkInfo.size <= 0) {
        process.exitCode = 1;
        throw Error(`Expected Android APK was not produced: ${apkPath}`);
      }
    }
    return;
  }

  const target = parsed.device ? 'device' : 'simulator';
  const derived = resolve(parsed.derivedData ?? join(root, 'evidence/private/mobile-' + target));
  const entitlements = join(
    root,
    'native',
    parsed.simulator
      ? 'codelync-simulator.entitlements'
      : parsed.pushEnvironment
        ? `codelync-push-${parsed.pushEnvironment}.entitlements`
        : 'codelync-development.entitlements',
  );
  await access(entitlements);
  const buildArgs = [
    '-workspace', 'ios/Codelync.xcworkspace',
    '-scheme', 'Codelync',
    '-configuration', parsed.configuration,
    '-destination', parsed.device && parsed.generic
      ? 'generic/platform=iOS'
      : parsed.simulator
        ? `platform=iOS Simulator,id=${parsed.simulator}`
        : `id=${parsed.device}`,
    '-derivedDataPath', derived,
    'CODE_SIGN_ENTITLEMENTS=' + entitlements,
    'CODE_SIGN_STYLE=' + (parsed.profileName ? 'Manual' : 'Automatic'),
    ...(parsed.profileName ? ['PROVISIONING_PROFILE_SPECIFIER=' + parsed.profileName] : []),
    ...(parsed.device
      ? [
          'DEVELOPMENT_TEAM=' + parsed.team,
          'CODE_SIGN_IDENTITY=' + (parsed.pushEnvironment === 'production' ? 'Apple Distribution' : 'Apple Development'),
        ]
      : ['CODE_SIGN_IDENTITY=-', 'ONLY_ACTIVE_ARCH=YES']),
    ...(parsed.allowProvisioningUpdates ? ['-allowProvisioningUpdates'] : []),
    '-jobs', '8',
    'build',
  ];

  if (parsed.dryRun) {
    console.log(JSON.stringify({
      cwd: join(root, 'apps/mobile'),
      args: buildArgs,
      entitlements,
      pushEnvironment: parsed.pushEnvironment ?? null,
    }));
    return;
  }

  await mkdir(derived, { recursive: true });
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    NODE_BINARY: process.execPath,
    CODELYNC_NONINVASIVE_LOCAL: '1',
    EXPO_NO_DOTENV: '1',
  };
  delete env.EXPO_PUBLIC_CODELYNC_SERVER_URL;
  delete env.EXPO_PUBLIC_SERVER_URL;
  if (parsed.pushEnvironment) env.CODELYNC_APNS_ENVIRONMENT = parsed.pushEnvironment;
  else delete env.CODELYNC_APNS_ENVIRONMENT;
  // 迁移后的签名文件必须从新 repo 解析；错误退出码直接传播，不能被 tail/rg 的成功状态掩盖。
  const child = spawn('xcodebuild', buildArgs, { cwd: join(root, 'apps/mobile'), env, stdio: 'inherit' });
  const iosExitCode = await /** @type {Promise<number>} */ (new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', code => done(code ?? 1));
  }));
  process.exitCode = iosExitCode;
  if (iosExitCode === 0 && parsed.pushEnvironment) {
    console.log(JSON.stringify(
      await verifyMobilePushArtifact(
        join(derived, `Build/Products/${parsed.configuration}-iphoneos/Codelync.app`),
        parsed.pushEnvironment,
        parsed.device,
      ),
    ));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runMobileBuild();
}
