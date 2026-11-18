import { isAbsolute, resolve } from 'node:path';
import { readOptionalPrivateJson, writeDurablePrivateJson } from './discovery-persistence.mjs';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
export const DESKTOP_SOURCE_APPS = Object.freeze(['codex', 'antigravity', 'claude-desktop']);
const invalid = () => new BridgeError('invalid-source-subscriptions', 'Choose only supported desktop sources.', 400);

const sameApps = (/** @type {readonly string[]} */ left, /** @type {readonly string[]} */ right) =>
  left.length === right.length && left.every((app, index) => app === right[index]);

/** @param {unknown} value @returns {string[]} */
export function parseEnabledDesktopApps(value) {
  if (!Array.isArray(value) || value.length > DESKTOP_SOURCE_APPS.length) throw invalid();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw invalid();
    const app = value[index];
    if (typeof app !== 'string' || !DESKTOP_SOURCE_APPS.includes(app)) throw invalid();
  }
  if (new Set(value).size !== value.length) throw invalid();
  return DESKTOP_SOURCE_APPS.filter(app => value.includes(app));
}

/** @typedef {{version:1, enabledApps:readonly string[], known:boolean, code:string|null, revision:number}} SourceSubscriptionSnapshot */
/** Profile-local preferences only; this owner never calls a native app. */
export class DesktopSourceSubscriptions {
  /** @type {string[]} */ #enabled = [];
  #known = false; #configured = false; #revision = 0;
  #appRevisions = new Map(DESKTOP_SOURCE_APPS.map(app => [app, 0]));
  #tail = Promise.resolve();
  /** @param {{path:string,read?:(path:string)=>Promise<unknown>,write?:(path:string,value:unknown)=>Promise<void>}} options */
  constructor(options) {
    if (!options || typeof options.path !== 'string' || !isAbsolute(options.path)) throw invalid();
    this.path = resolve(options.path); this.read = options.read ?? readOptionalPrivateJson; this.write = options.write ?? writeDurablePrivateJson;
  }
  get revision() { return this.#revision; }
  /** Other app choices cannot invalidate an unchanged app's existing lease. @param {string} app */
  appRevision(app) { return this.#appRevisions.get(app) ?? 0; }
  /** @returns {SourceSubscriptionSnapshot} */
  snapshot() {
    return Object.freeze({ version: 1, enabledApps: Object.freeze([...this.#enabled]), known: this.#known,
      code: this.#known ? null : 'source-subscriptions-unavailable', revision: this.#revision });
  }
  /** @param {string} app */
  isEnabled(app) { return this.#known && this.#enabled.includes(app); }
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  #serial(operation) {
    const result = this.#tail.then(operation); this.#tail = result.then(() => {}, () => {}); return result;
  }
  /** @param {string[]} enabled @param {boolean} known @param {boolean} configured */
  #apply(enabled, known, configured) {
    for (const app of DESKTOP_SOURCE_APPS) if ((known && enabled.includes(app)) !== (this.#known && this.#enabled.includes(app))) this.#appRevisions.set(app, this.appRevision(app) + 1);
    if (known !== this.#known || !sameApps(enabled, this.#enabled)) this.#revision++;
    this.#enabled = enabled; this.#known = known; this.#configured = configured; return this.snapshot();
  }
  /** Safe reload never writes defaults or overwrites an unreadable file. */
  reload() {
    return this.#serial(async () => {
      try {
        const value = await this.read(this.path);
        if (value === null) return this.#apply([...DESKTOP_SOURCE_APPS], true, false);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) throw invalid();
        const keys = Object.getOwnPropertyNames(value);
        if (keys.length !== 2 || !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'enabledApps')) throw invalid();
        const versionDesc = Object.getOwnPropertyDescriptor(value, 'version');
        const appsDesc = Object.getOwnPropertyDescriptor(value, 'enabledApps');
        if (!versionDesc || !appsDesc || versionDesc.get || appsDesc.get) throw invalid();
        const record = /** @type {Value} */ (value);
        if (record.version !== 1) throw invalid();
        return this.#apply(parseEnabledDesktopApps(record.enabledApps), true, true);
      } catch { return this.#apply([], false, false); }
    });
  }
  /** Persist intent before the synchronous source gate changes. @param {unknown} value */
  async setEnabledApps(value) {
    const enabled = parseEnabledDesktopApps(value);
    return this.#serial(async () => {
      if (this.#known && this.#configured && sameApps(enabled, this.#enabled)) return this.snapshot();
      try { await this.write(this.path, { version: 1, enabledApps: enabled }); }
      catch { throw new BridgeError('source-subscriptions-save-failed', 'The desktop source choices could not be saved.', 503); }
      return this.#apply(enabled, true, true);
    });
  }
}
