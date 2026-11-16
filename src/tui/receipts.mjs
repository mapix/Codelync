import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, link, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string, any>} Value */
/** @param {string} action @param {Value} payload @param {string} paneId @param {string} ownerGeneration */
export function terminalCommandDigest(action, payload, paneId, ownerGeneration) {
  const canonicalPayload = Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(JSON.stringify({ action, payload: canonicalPayload, paneId, ownerGeneration })).digest('hex');
}

/** Content-free durable receipts; old unknown records are never replayed or evicted. */
export class TerminalReceiptJournal {
  /** @param {string} directory */
  constructor(directory) { this.directory = directory; }

  /** @param {string} commandId */
  path(commandId) {
    if (typeof commandId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(commandId)) throw new BridgeError('tui-invalid-command-id', 'A bounded stable terminal command ID is required.');
    return join(this.directory, `${createHash('sha256').update(commandId).digest('hex')}.json`);
  }

  /** @param {string} commandId */
  async get(commandId) {
    const path = this.path(commandId); let text;
    try { text = await readFile(path, 'utf8'); } catch (error) { if (/** @type {Value} */ (error).code === 'ENOENT') return null; throw error; }
    if (Buffer.byteLength(text) > 16 * 1024) throw new BridgeError('tui-receipt-invalid', 'The saved terminal receipt exceeds its bound.');
    let value; try { value = JSON.parse(text); } catch { throw new BridgeError('tui-receipt-invalid', 'The saved terminal receipt is unreadable.'); }
    if (value?.version !== 1 || value.commandId !== commandId || !['unknown', 'completed', 'rejected'].includes(value.status)
      || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest) || !/^%\d+$/u.test(value.paneId)
      || typeof value.ownerGeneration !== 'string') throw new BridgeError('tui-receipt-invalid', 'The saved terminal receipt identity is invalid.');
    return value;
  }

  /** @param {Value} operation */
  async begin(operation) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(operation.commandId);
    const value = { version: 1, commandId: operation.commandId, paneId: operation.paneId, ownerGeneration: operation.ownerGeneration,
      action: operation.action, digest: operation.digest, status: 'unknown', createdAt: Date.now(), receipt: null };
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await this.writeTemporary(temporary, value);
    let created = false;
    try { await link(temporary, path); created = true; await this.syncDirectory(); }
    catch (error) { if (/** @type {Value} */ (error).code !== 'EEXIST') throw error; }
    finally { await unlink(temporary).catch(() => {}); }
    const record = created ? value : await this.get(operation.commandId);
    if (!record || record.digest !== operation.digest || record.ownerGeneration !== operation.ownerGeneration || record.paneId !== operation.paneId) {
      throw new BridgeError('tui-command-id-conflict', 'This terminal command ID already belongs to another operation.', 409);
    }
    return { created, record };
  }

  /** @param {Value} operation @param {Value} receipt */
  async finish(operation, receipt) {
    const previous = await this.get(operation.commandId);
    if (!previous || previous.digest !== operation.digest || previous.ownerGeneration !== operation.ownerGeneration || previous.paneId !== operation.paneId) {
      throw new BridgeError('tui-command-id-conflict', 'This terminal receipt belongs to another operation.', 409);
    }
    const path = this.path(operation.commandId), temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await this.writeTemporary(temporary, { ...previous, status: receipt.status, receipt, completedAt: Date.now() });
    try { await rename(temporary, path); await this.syncDirectory(); }
    finally { await unlink(temporary).catch(() => {}); }
    return receipt;
  }

  /** @param {string} path @param {Value} value */
  async writeTemporary(path, value) {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  }

  async syncDirectory() { const handle = await open(this.directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
}
