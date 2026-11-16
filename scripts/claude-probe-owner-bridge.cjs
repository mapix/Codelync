// Isolated-copy entry only. Never install this into the user's original app.
const electron = require('electron'), http = require('node:http'), fs = require('node:fs');
const crypto = require('node:crypto'), cp = require('node:child_process');
const { ClaudeCommandReceipts } = require('./codelight-command-receipts.cjs');
const runtimePath = process.env.CODELIGHT_CLAUDE_BRIDGE_MANIFEST;
const external = process.env.CODELIGHT_CLAUDE_BRIDGE_HANDLERS;
if (!runtimePath || !external || electron.app.getVersion() !== '4.16336.0') throw Error('unverified-probe-owner');
const epoch = crypto.randomBytes(16).toString('hex'), token = crypto.randomBytes(32).toString('hex');
const receipts = new ClaudeCommandReceipts(); let runtime, code, cowork;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mutation = method => /^(code|cowork)\.(initialize|prepare|create|send|interrupt|stop|permission|setModel|setEffort)$/.test(method);
function manager(mode) {
  if (mode === 'code') return code ??= require('./index.chunk-CqaSnEfn.js').claudeCodeSessionManager;
  if (mode === 'cowork') return cowork ??= require('./index.chunk-vuRwhTdh.js').n;
  throw Error('unverified-mode');
}
async function invoke(packet) {
  delete require.cache[require.resolve(external)];
  return require(external)({ method: packet.method, params: packet.params ?? {}, manager, electron });
}
function send(res, packet, result, error, started) {
  const ok = !error;
  const body = JSON.stringify({ version: 1, ok, ownerGeneration: runtime.generation, hostId: runtime.hostId,
    ...(packet?.commandId ? { commandId: packet.commandId } : {}),
    ...(ok ? { result } : { error: { code: /^[a-z][a-z-]{0,64}$/.test(error.message) ? error.message : 'native-operation-unavailable' },
      effectMayHaveOccurred: started && error.effectMayHaveOccurred !== false }) });
  res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' }).end(body);
}
electron.app.whenReady().then(() => {
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return; }
    if (req.url !== '/rpc' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body = '', packet, started = false;
    try {
      for await (const part of req) { body += part; if (body.length > 131072) throw Error('bounded-request'); }
      packet = JSON.parse(body);
      if (packet.version !== 1 || !/^(owner|code|cowork|chat)\.[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(packet.method ?? '')) throw Error('invalid-request');
      const operation = mutation(packet.method)
        ? receipts.admit(packet.commandId, packet.method, packet.params ?? {}, () => invoke(packet))
        : Promise.resolve().then(() => invoke(packet));
      started = true;
      const result = await receipts.wait(operation, 10000);
      send(res, packet, result);
    } catch (error) { send(res, packet, null, error, started); }
  });
  server.listen(0, '127.0.0.1', () => {
    const startTime = cp.execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    runtime = { version: 1, protocol: 'claude-desktop-native', pid: process.pid, parentPid: process.ppid, startTime,
      executable: process.execPath, storagePath: fs.realpathSync(electron.app.getPath('userData')), profileNamespace: 'isolated-probe',
      bootEpoch: epoch, accessToken: token, origin: 'http://127.0.0.1:' + server.address().port, appVersion: electron.app.getVersion() };
    runtime.generation = 'claude-desktop:' + hash([runtime.executable, runtime.pid, runtime.parentPid, runtime.startTime, runtime.bootEpoch]);
    runtime.hostId = 'local:claude-desktop:' + hash([runtime.storagePath, runtime.profileNamespace]);
    fs.writeFileSync(runtimePath, JSON.stringify(runtime), { mode: 0o600 });
  });
  electron.app.once('before-quit', () => server.close());
});
