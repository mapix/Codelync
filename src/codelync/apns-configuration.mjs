import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createPrivateKey, createHash, randomUUID } from 'node:crypto';
import { readOptionalPrivateJson, writeDurablePrivateJson } from './discovery-persistence.mjs';
import { loadAPNsSender } from './apns-sender.mjs';
/** @typedef {Record<string,any>} Value */
/** Publisher configuration is owned by the local Mac UI, never a phone endpoint. */
export class APNsConfiguration {
  /** @param {{state:string,devices:import('./device-registry.mjs').DeviceRegistry,peerId:()=>string,origin:()=>string,changed:(sender:Value|null)=>Promise<void>,notify:(value:Value)=>void}} options */
  constructor(options) { this.options = options; this.path = join(options.state, 'apns.json'); this.sender = /** @type {Value|null} */ (null); this.config = /** @type {Value|null} */ (null); this.tail = Promise.resolve(); this.lastTestAccepted = false; }
  status() { return { available: !!this.sender, environment: this.config?.environment ?? 'development', keyId: this.config?.keyId ?? '', teamId: this.config?.teamId ?? '', lastTestAccepted: this.lastTestAccepted }; }
  publish() { this.options.notify({ type: 'notifications', ...this.status() }); }
  async load() { this.config = await readOptionalPrivateJson(this.path); this.sender = await loadAPNsSender(this.path); this.publish(); return this.sender; }
  /** @param {Value} input */
  async configure(input) {
    const keyId = input.keyId, teamId = input.teamId, environment = input.environment;
    if (!/^[A-Z0-9]{10}$/u.test(keyId ?? '') || !/^[A-Z0-9]{10}$/u.test(teamId ?? '') || !['development', 'production'].includes(environment)) throw Error('invalid-apns-configuration');
    const keyPath = input.keyPath || this.config?.keyPath;
    if (typeof keyPath !== 'string' || !isAbsolute(keyPath)) throw Error('apns-key-required');
    const key = await readFile(keyPath); if (key.length > 16384) throw Error('invalid-apns-key');
    const parsed = createPrivateKey(key);
    if (parsed.asymmetricKeyType !== 'ec' || parsed.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error('invalid-apns-key');
    const directory = join(this.options.state, 'apns'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, createHash('sha256').update(key).digest('hex') + '.p8');
    let created = false;
    try {
      const file = await open(destination, 'wx', 0o600); created = true;
      try { await file.writeFile(key); await file.sync(); } finally { await file.close(); }
    } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error; }
    const config = { keyPath: destination, keyId, teamId, topic: 'com.learnings.codelync', environment };
    try { await writeDurablePrivateJson(this.path, config); }
    catch (error) { if (created) await unlink(destination).catch(() => {}); throw error; }
    this.config = config; this.sender = await loadAPNsSender(this.path); this.lastTestAccepted = false;
    await this.options.changed(this.sender); this.publish();
  }
  /** Explicit test alerts never dispatch a model prompt or native command. @param {string} id */
  async test(id) {
    const device = this.options.devices.notificationDevices().find(row => row.id === id);
    if (!this.sender) throw Error('apns-not-configured');
    if (!device) throw Error('push-device-not-registered');
    if (!this.sender.multiEnvironment && device.push.environment !== this.sender.environment) throw Error('push-environment-mismatch');
    const result = await this.sender.send(device.push.token, { id: randomUUID(), kind: 'test', sessionId: device.presence?.sessionId ?? undefined, peerId: this.options.peerId(), origin: this.options.origin() }, device.push.environment);
    if (result.invalidToken) await this.options.devices.disablePush(id);
    this.lastTestAccepted = result.ok; this.publish();
    if (!result.ok) throw Error(result.reason || 'apns-delivery-failed');
  }
  /** @param {Value} command */
  handle(command) {
    if (!['configure-notifications', 'test-notifications'].includes(command?.type)) return false;
    if (typeof command.requestId !== 'string' || !command.requestId || command.requestId.length > 128) return true;
    const run = this.tail.catch(() => {}).then(() => command.type === 'configure-notifications' ? this.configure(command.configuration ?? {}) : this.test(command.id));
    this.tail = run.then(() => this.options.notify({ type: 'notifications-result', requestId: command.requestId, ok: true }))
      .catch(error => this.options.notify({ type: 'notifications-result', requestId: command.requestId, ok: false, code: /^[A-Za-z-]{1,80}$/u.test(error.message) ? error.message : 'notification-configuration-failed' }));
    return true;
  }
  idle() { return this.tail; }
}
