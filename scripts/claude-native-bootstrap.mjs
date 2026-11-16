import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { findClaudeNativeDebugger, ClaudeNativeDebugger, attestClaudeStockOwner } from '../src/adapters/claude-native-debugger.mjs';

// Administrative bootstrap only; no CLI/TUI/model runner is launched.
const [action = 'status', appRootArg = '/Applications/Claude.app', runtimePathArg, bridgePathArg] = process.argv.slice(2);
const appRoot = resolve(appRootArg), executable = join(appRoot, 'Contents/MacOS/Claude');
const runtimePath = runtimePathArg ? resolve(runtimePathArg) : null, bridgePath = bridgePathArg ? resolve(bridgePathArg) : null;
const profilePath = process.env.CODELIGHT_CLAUDE_EXPECTED_PROFILE;
const asarSha256 = process.env.CODELIGHT_CLAUDE_EXPECTED_ASAR;
const readOnly = process.env.CODELIGHT_CLAUDE_READ_ONLY === '1';
if (!profilePath || !asarSha256 || !/^[a-f0-9]{64}$/.test(asarSha256) || !['status', 'install', 'remove'].includes(action)) throw Error('Explicit attested profile/artifact and bootstrap action are required.');
const candidates = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
  const match = line.trim().match(/^(\d+)\s+(.+)$/); return match && match[2] === executable ? [Number(match[1])] : [];
});
if (candidates.length !== 1) throw Error('Exactly one existing native owner is required; this tool never launches it.');
const target = await findClaudeNativeDebugger({ pid: candidates[0], executable }), client = new ClaudeNativeDebugger({ endpoint: target.endpoint });
try {
  await client.connect(); const proof = await attestClaudeStockOwner(client, { identity: target.identity, appRoot, profilePath, asarSha256 });
  if (action === 'status') { process.stdout.write(JSON.stringify(proof) + '\n'); }
  else if (action === 'install') {
    if (!readOnly && !proof.idle) throw Error('The native owner is not idle; no session was stopped or restarted.');
    if (!runtimePath || !bridgePath) throw Error('A private manifest path and reviewed standalone bridge artifact are required.');
    await readFile(bridgePath); const options = { runtimePath, expectedAsarSha256: asarSha256, profileNamespace: 'stock-desktop', readOnly };
    const result = await client.evaluate(`(async()=>{const require=process.mainModule.require.bind(process.mainModule),artifact=require(${JSON.stringify(bridgePath)}),bridge=await artifact.installClaudeOwnerBridge({electron:require('electron'),hostRequire:require,...${JSON.stringify(options)}});return {installed:true,pid:bridge.pid,version:bridge.version};})()`);
    process.stdout.write(JSON.stringify({ ...result, readOnly, mutationAllowed: !readOnly, gatewayVerified: proof.gatewayVerified, appVersion: proof.appVersion, asarSha256: proof.asarSha256 }) + '\n');
  } else {
    const result = await client.evaluate(`(async()=>{const bridge=globalThis[Symbol.for('codelight.claude.native.owner.v1')];if(bridge)await bridge.deactivate();return {removed:true,nativeQueriesNotStopped:true};})()`);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
} finally { client.close(); }
