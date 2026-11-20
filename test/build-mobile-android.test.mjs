import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildAndroidGradleEnv,
  ensureAndroidReleaseSigning,
  parseMobileBuildArgs,
  resolveAndroidToolchain,
} from '../scripts/build-mobile.mjs';
import { publicSourcePath } from '../src/release/source-snapshot.mjs';

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('parseMobileBuildArgs preserves default iOS contract and validates Android Debug/Release flags', async () => {
  const iosSim = parseMobileBuildArgs(['--simulator', 'fixture-sim', '--dry-run']);
  assert.equal(iosSim.platform, 'ios');
  assert.equal(iosSim.configuration, 'Release');
  assert.equal(iosSim.dryRun, true);

  const { stdout: iosPlanRaw } = await run(
    process.execPath,
    ['scripts/build-mobile.mjs', '--simulator', 'fixture-simulator', '--dry-run'],
    { cwd: repoRoot },
  );
  const iosPlan = JSON.parse(iosPlanRaw);
  assert.equal(iosPlan.cwd, join(repoRoot, 'apps/mobile'));
  assert.equal(iosPlan.entitlements, join(repoRoot, 'native/codelync-simulator.entitlements'));
  assert.equal(iosPlan.pushEnvironment, null);

  const androidDebug = parseMobileBuildArgs(['--', '--platform', 'android', '--configuration', 'Debug']);
  assert.deepEqual(androidDebug, { platform: 'android', configuration: 'Debug', dryRun: false });

  const androidRelease = parseMobileBuildArgs(['--platform', 'android', '--configuration', 'Release', '--dry-run']);
  assert.deepEqual(androidRelease, { platform: 'android', configuration: 'Release', dryRun: true });

  const androidDefault = parseMobileBuildArgs(['--platform', 'android']);
  assert.deepEqual(androidDefault, { platform: 'android', configuration: 'Release', dryRun: false });

  assert.throws(() => parseMobileBuildArgs(['--unknown-flag']), /Unknown build option/);
  assert.throws(() => parseMobileBuildArgs(['--platform']), /requires a value/);
  assert.throws(() => parseMobileBuildArgs(['--platform', 'web']), /Platform must be ios or android/);
  assert.throws(() => parseMobileBuildArgs(['--platform', 'android', '--configuration', 'Staging']), /Debug or Release/);
  assert.throws(() => parseMobileBuildArgs(['--platform', 'android', '--simulator', 'sim-1']), /only supported for iOS/);
  assert.throws(() => parseMobileBuildArgs(['--platform', 'android', '--push-environment', 'production']), /only supported for iOS/);
});

test('Android --dry-run plans and Gradle env force APP_ENV=production on Release and strip push/server overrides', async () => {
  const { stdout: releaseRaw } = await run(
    process.execPath,
    ['scripts/build-mobile.mjs', '--platform', 'android', '--configuration', 'Release', '--dry-run'],
    { cwd: repoRoot },
  );
  const releasePlan = JSON.parse(releaseRaw);
  assert.equal(releasePlan.platform, 'android');
  assert.equal(releasePlan.configuration, 'Release');
  assert.equal(releasePlan.appEnv, 'production');
  assert.equal(releasePlan.args[0], 'assembleRelease');
  assert.match(releasePlan.args[1], /^-PreactNativeNodeExecutable=/u);
  assert.ok(releasePlan.apkPath.endsWith('apps/mobile/android/app/build/outputs/apk/release/app-release.apk'));

  const { stdout: debugRaw } = await run(
    process.execPath,
    ['scripts/build-mobile.mjs', '--platform', 'android', '--configuration', 'Debug', '--dry-run'],
    { cwd: repoRoot },
  );
  const debugPlan = JSON.parse(debugRaw);
  assert.equal(debugPlan.configuration, 'Debug');
  assert.equal(debugPlan.args[0], 'assembleDebug');
  assert.ok(debugPlan.apkPath.endsWith('apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk'));

  const sanitized = buildAndroidGradleEnv({
    baseEnv: {
      PATH: '/usr/bin',
      APP_ENV: 'development',
      EXPO_PUBLIC_CODELYNC_SERVER_URL: 'https://leak.example',
      EXPO_PUBLIC_SERVER_URL: 'https://leak2.example',
      CODELYNC_APNS_ENVIRONMENT: 'production',
    },
    configuration: 'Release',
    nodeBinary: process.execPath,
    javaHome: '/opt/jdk',
    androidHome: '/opt/android-sdk',
  });
  assert.equal(sanitized.APP_ENV, 'production');
  assert.equal(sanitized.CODELYNC_NONINVASIVE_LOCAL, '1');
  assert.equal(sanitized.EXPO_NO_DOTENV, '1');
  assert.equal(sanitized.EXPO_PUBLIC_CODELYNC_SERVER_URL, undefined);
  assert.equal(sanitized.EXPO_PUBLIC_SERVER_URL, undefined);
  assert.equal(sanitized.CODELYNC_APNS_ENVIRONMENT, undefined);
});

test('ensureAndroidReleaseSigning deterministically reuses local .signing keystore and fails closed on invalid explicit store', async t => {
  const tempDir = await mkdtemp(join(tmpdir(), 'codelync-android-sign-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const toolchain = resolveAndroidToolchain(process.env);

  const first = await ensureAndroidReleaseSigning({
    androidDir: tempDir,
    javaHome: toolchain.javaHome,
    env: {},
    cwd: tempDir,
    workspaceRoot: tempDir,
  });
  assert.equal(first.mode, 'local-generated');
  assert.equal(first.keyAlias, 'codelync-release');
  assert.equal(first.storeFile, join(tempDir, '.signing/codelync-release.keystore'));
  const firstBytes = await readFile(first.storeFile);
  assert.ok(firstBytes.byteLength > 500);

  const second = await ensureAndroidReleaseSigning({
    androidDir: tempDir,
    javaHome: toolchain.javaHome,
    env: {},
    cwd: tempDir,
    workspaceRoot: tempDir,
  });
  const secondBytes = await readFile(second.storeFile);
  assert.equal(second.storePassword, first.storePassword);
  assert.deepEqual(secondBytes, firstBytes);

  await assert.rejects(
    ensureAndroidReleaseSigning({
      androidDir: tempDir,
      javaHome: toolchain.javaHome,
      env: { CODELYNC_UPLOAD_STORE_FILE: first.storeFile },
    }),
    /requires CODELYNC_UPLOAD_STORE_PASSWORD/,
  );

  await assert.rejects(
    ensureAndroidReleaseSigning({
      androidDir: tempDir,
      javaHome: toolchain.javaHome,
      env: {
        CODELYNC_UPLOAD_STORE_FILE: join(tempDir, 'missing.keystore'),
        CODELYNC_UPLOAD_STORE_PASSWORD: first.storePassword,
      },
    }),
    /does not exist/,
  );

  const explicit = await ensureAndroidReleaseSigning({
    androidDir: join(tempDir, 'other'),
    javaHome: toolchain.javaHome,
    env: {
      CODELYNC_UPLOAD_STORE_FILE: first.storeFile,
      CODELYNC_UPLOAD_STORE_PASSWORD: first.storePassword,
      CODELYNC_UPLOAD_KEY_ALIAS: 'codelync-release',
    },
  });
  assert.equal(explicit.mode, 'explicit');
  assert.equal(explicit.storeFile, first.storeFile);
});

test('package.json scripts, AndroidManifest.xml, app/build.gradle and Codelync branding satisfy M2 contract', async () => {
  const [rootPkgRaw, mobilePkgRaw, manifest, appGradle, gradleProps, colorsXml] = await Promise.all([
    readFile(join(repoRoot, 'package.json'), 'utf8'),
    readFile(join(repoRoot, 'apps/mobile/package.json'), 'utf8'),
    readFile(join(repoRoot, 'apps/mobile/android/app/src/main/AndroidManifest.xml'), 'utf8'),
    readFile(join(repoRoot, 'apps/mobile/android/app/build.gradle'), 'utf8'),
    readFile(join(repoRoot, 'apps/mobile/android/gradle.properties'), 'utf8'),
    readFile(join(repoRoot, 'apps/mobile/android/app/src/main/res/values/colors.xml'), 'utf8'),
  ]);
  const rootPkg = JSON.parse(rootPkgRaw);
  const mobilePkg = JSON.parse(mobilePkgRaw);

  assert.equal(rootPkg.scripts['build:mobile'], 'node scripts/build-mobile.mjs');
  assert.match(rootPkg.scripts['build:android:debug'], /--platform android --configuration Debug/u);
  assert.match(rootPkg.scripts['build:android:release'], /--platform android --configuration Release/u);
  assert.match(mobilePkg.scripts['build:android:debug'], /build-mobile\.mjs --platform android --configuration Debug/u);
  assert.match(mobilePkg.scripts['build:android:release'], /build-mobile\.mjs --platform android --configuration Release/u);
  assert.match(mobilePkg.scripts['prebuild:android'], /APP_ENV=production/u);

  assert.match(manifest, /android:usesCleartextTraffic="true"/u);
  assert.match(manifest, /android:scheme="codelync"/u);
  assert.match(manifest, /android:host="codelync\.novarock\.io"/u);
  for (const blocked of [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
  ]) {
    assert.match(manifest, new RegExp(`<uses-permission[^>]*android:name="${blocked.replaceAll('.', '\\.')}"[^>]*tools:node="remove"`, 'u'));
    assert.doesNotMatch(manifest, new RegExp(`<uses-permission\\s+android:name="${blocked.replaceAll('.', '\\.')}"\\s*/>`, 'u'));
  }

  assert.match(appGradle, /namespace\s+['"]com\.learnings\.codelync['"]/u);
  assert.match(appGradle, /applicationId\s+['"]com\.learnings\.codelync['"]/u);
  assert.match(appGradle, /versionCode\s+2026112001\b/u);
  assert.match(appGradle, /versionName\s+['"]1\.0\.2['"]/u);
  assert.match(appGradle, /nodeExecutableAndArgs\s*=\s*\[nodeExecutable\]/u);
  assert.match(appGradle, /CODELYNC_UPLOAD_STORE_FILE/u);
  assert.match(appGradle, /\.signing\/codelync-release\.keystore/u);
  assert.match(appGradle, /\.signing\/credentials\.key/u);
  assert.match(appGradle, /\*\*\/libc\+\+_shared\.so/u);

  assert.match(gradleProps, /^newArchEnabled=true$/mu);
  assert.match(gradleProps, /^hermesEnabled=true$/mu);
  assert.match(gradleProps, /^edgeToEdgeEnabled=true$/mu);
  assert.match(colorsXml, /#0142F3/iu);

  for (const asset of [
    'codelync-icon-adaptive.png',
    'codelync-icon-monochrome.png',
    'codelync-splash-android-light.png',
    'codelync-splash-android-dark.png',
    'codelync-icon-notification.png',
  ]) {
    const filePath = join(repoRoot, 'apps/mobile/sources/assets/images', asset);
    const info = await stat(filePath);
    assert.ok(info.size > 256, `${asset} should be non-empty`);
    const magic = (await readFile(filePath)).subarray(0, 4);
    assert.deepEqual([...magic], [0x89, 0x50, 0x4e, 0x47], `${asset} must be a valid PNG`);
  }
});

test('gitignore, publicSourcePath and private-path hygiene exclude Android secrets/APKs and forbid hardcoded home paths', async () => {
  for (const allowed of [
    'apps/mobile/android/app/build.gradle',
    'apps/mobile/android/gradlew',
    'apps/mobile/android/gradle/wrapper/gradle-wrapper.jar',
  ]) {
    assert.equal(publicSourcePath(allowed), true, allowed);
  }
  for (const excluded of [
    'apps/mobile/android/.signing/codelync-release.keystore',
    'apps/mobile/android/.signing/credentials.key',
    'apps/mobile/android/app/debug.keystore',
    'apps/mobile/android/app/build/outputs/apk/release/app-release.apk',
    'apps/mobile/android/.gradle/config.properties',
  ]) {
    assert.equal(publicSourcePath(excluded), false, excluded);
  }

  for (const ignoredPath of [
    'apps/mobile/android/.signing/codelync-release.keystore',
    'apps/mobile/android/.signing/credentials.key',
    'apps/mobile/android/local.properties',
    'apps/mobile/android/app/debug.keystore',
    'apps/mobile/android/app/build/outputs/apk/release/app-release.apk',
    'apps/mobile/android/.kotlin/sessions/cache.bin',
    'apps/mobile/android/app/.cxx/cmake/debug/arm64-v8a/compile_commands.json',
  ]) {
    const { stdout } = await run('git', ['check-ignore', ignoredPath], { cwd: repoRoot });
    assert.equal(stdout.trim(), ignoredPath);
  }

  const privateHomePattern = new RegExp(['', 'Users', ''].join('/') + '|C:\\\\Users\\\\', 'u');
  for (const tracked of [
    'scripts/build-mobile.mjs',
    'apps/mobile/app.config.js',
    'apps/mobile/android/app/build.gradle',
    'apps/mobile/android/settings.gradle',
    'apps/mobile/android/gradle.properties',
    'test/build-mobile-android.test.mjs',
  ]) {
    const content = await readFile(join(repoRoot, tracked), 'utf8');
    assert.doesNotMatch(content, privateHomePattern, `Forbidden home path literal in ${tracked}`);
  }
});

test('compiled Release APK (when built locally) passes apksigner, aapt2 manifest/permission checks and bundles Hermes + native .so libs', async t => {
  const releaseApk = join(repoRoot, 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk');
  if (!existsSync(releaseApk)) {
    t.skip('app-release.apk has not been built yet in this checkout');
    return;
  }
  const toolchain = resolveAndroidToolchain(process.env);
  const buildToolsDir = join(toolchain.androidHome, 'build-tools', '36.0.0');
  const apksigner = join(buildToolsDir, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
  const aapt2 = join(buildToolsDir, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
  if (!existsSync(apksigner) || !existsSync(aapt2)) {
    t.skip('Android SDK build-tools 36.0.0 not installed on host');
    return;
  }

  const signOut = await run(apksigner, ['verify', '--verbose', '--print-certs', releaseApk], {
    env: { ...process.env, JAVA_HOME: toolchain.javaHome },
  });
  assert.match(signOut.stdout, /Verified using v2 scheme/u);
  assert.doesNotMatch(signOut.stdout, /CN=Android Debug/u);

  const badging = await run(aapt2, ['dump', 'badging', releaseApk]);
  assert.match(badging.stdout, /package: name='com\.learnings\.codelync' versionCode='2026112001' versionName='1\.0\.2'/u);

  const perms = await run(aapt2, ['dump', 'permissions', releaseApk]);
  for (const forbidden of [
    'POST_NOTIFICATIONS',
    'READ_EXTERNAL_STORAGE',
    'WRITE_EXTERNAL_STORAGE',
    'READ_MEDIA_IMAGES',
    'READ_MEDIA_VIDEO',
  ]) {
    assert.doesNotMatch(perms.stdout, new RegExp(forbidden, 'u'));
  }

  const xmltree = await run(aapt2, ['dump', 'xmltree', releaseApk, '--file', 'AndroidManifest.xml']);
  assert.match(xmltree.stdout, /usesCleartextTraffic.*=(true|\(type 0x12\)0xffffffff)/u);
  assert.match(xmltree.stdout, /"codelync"/u);
  assert.match(xmltree.stdout, /"codelync\.novarock\.io"/u);

  const entries = await run('unzip', ['-l', releaseApk], { maxBuffer: 16 * 1024 * 1024 });
  assert.match(entries.stdout, /assets\/index\.android\.bundle/u);
  for (const soName of [
    'libhermesvm.so',
    'libsodium.so',
    'liblibsodium.so',
    'libreact-native-mmkv.so',
    'libNitroModules.so',
    'libunistyles.so',
    'libquickbase64.so',
    'libreanimated.so',
    'libworklets.so',
    'libjingle_peerconnection_so.so',
  ]) {
    assert.match(entries.stdout, new RegExp(`lib/arm64-v8a/${soName.replace('.', '\\.')}`, 'u'));
  }
});
