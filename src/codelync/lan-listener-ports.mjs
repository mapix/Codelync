import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { isPrivateHost } from '@codelync/wire/codelync';
import { writeDurablePrivateJson } from './discovery-persistence.mjs';

/** @typedef {{host:string,port:number}} Listener */
/** Port hints are not peer identity or permission to trust a remote listener.
 * @param {unknown} value @returns {Listener[]} */
export function parseLanListenerPorts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const saved = /** @type {Record<string,unknown>} */ (value);
  if (saved.version !== 1 || Object.keys(saved).some(key => !['version', 'listeners'].includes(key)) ||
      !Array.isArray(saved.listeners) || saved.listeners.length > 3) return [];
  const hosts = new Set();
  /** @type {Listener[]} */ const listeners = [];
  for (const entry of saved.listeners) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['host', 'port'].includes(key))) return [];
    const { host, port } = /** @type {Record<string,unknown>} */ (entry);
    if (typeof host !== 'string' || isIP(host) !== 4 || !isPrivateHost(host) || host.startsWith('127.') ||
        typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1024 || port > 65535 || hosts.has(host)) return [];
    hosts.add(host); listeners.push({ host, port });
  }
  return listeners;
}

/** Invalid/missing hints never prevent a new owned listener from starting.
 * @param {string} state @returns {Promise<Map<string,number>>} */
export async function readLanListenerPorts(state) {
  try {
    const descriptor = await open(join(state, 'lan-listeners.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const file = await descriptor.stat();
      if (!file.isFile() || file.size > 4096 || file.mode & 0o077 || process.getuid && file.uid !== process.getuid()) return new Map();
      const buffer = Buffer.alloc(4097); let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await descriptor.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break; size += bytesRead;
      }
      if (size > 4096) return new Map();
      return new Map(parseLanListenerPorts(JSON.parse(buffer.subarray(0, size).toString('utf8'))).map(row => [row.host, row.port]));
    } finally { await descriptor.close(); }
  } catch { return new Map(); }
}

/** Saves only actual current binds, with no account/device/invitation material.
 * @param {string} state @param {Listener[]} listeners */
export async function writeLanListenerPorts(state, listeners) {
  const sorted = listeners.map(row => ({ host: row.host, port: row.port })).sort((a, b) => a.host.localeCompare(b.host));
  const value = { version: 1, listeners: sorted };
  if (parseLanListenerPorts(value).length !== sorted.length) throw Error('invalid-lan-listener-ports');
  const previous = await readLanListenerPorts(state);
  if (previous.size === sorted.length && sorted.every(row => previous.get(row.host) === row.port)) return;
  await writeDurablePrivateJson(join(state, 'lan-listeners.json'), value);
}
