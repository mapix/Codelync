import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';

/** @typedef {Record<string,any>} Value */
/** @param {string} dbPath */
function isWalDatabase(dbPath) {
  let fd = /** @type {number|null} */ (null);
  try {
    fd = openSync(dbPath, 'r');
    const header = Buffer.alloc(20);
    const bytesRead = readSync(fd, header, 0, 20, 0);
    return bytesRead === 20 && header.subarray(0, 16).toString('ascii') === 'SQLite format 3\0' && (header[18] === 2 || header[19] === 2);
  } catch { return false; }
  finally { if (fd !== null) try { closeSync(fd); } catch { /* ignore */ } }
}
/** @param {string} dbPath @param {unknown} error */
function sqliteWorkerError(dbPath, error) {
  const code = typeof (/** @type {Value} */ (error))?.code === 'string' ? /** @type {Value} */ (error).code : null;
  if (code === 'codex-index-unsupported' || code === 'codex-index-wal-missing') return code;
  const errcode = typeof (/** @type {Value} */ (error))?.errcode === 'number' ? /** @type {Value} */ (error).errcode : null;
  const base = errcode !== null ? errcode & 0xff : null;
  if (base === 5 || base === 6) return 'codex-index-busy';
  if (base === 11 || base === 26) return 'codex-index-invalid';
  if ((errcode === 1544 || base === 8 || base === 14) && existsSync(dbPath) && isWalDatabase(dbPath) && (!existsSync(dbPath + '-wal') || !existsSync(dbPath + '-shm'))) {
    return 'codex-index-wal-missing';
  }
  if (base === 14) return 'codex-index-missing';
  return 'codex-index-unavailable';
}

const root = typeof workerData?.root === 'string' && workerData.root ? workerData.root : null;
const dbPath = root ? join(root, 'state_5.sqlite') : '';
let db = /** @type {DatabaseSync|null} */ (null);
let inTx = false;
try {
  if (!root) throw Object.assign(new Error('Missing root'), { code: 'codex-index-unavailable' });
  // 独立包原先丢失 Python 脚本导致会话列表为空；内置 SQLite 只读连接不写原数据库，也不启动任何会话。
  db = new DatabaseSync(dbPath, { readOnly: true, timeout: 250 });
  db.exec('PRAGMA query_only=ON; BEGIN');
  inTx = true;
  const fields = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
  if (fields.size === 0 && isWalDatabase(dbPath) && !existsSync(dbPath + '-wal')) throw Object.assign(new Error('Missing WAL'), { code: 'codex-index-wal-missing' });
  if (!['id', 'cwd', 'created_at', 'updated_at', 'model_provider', 'archived'].every(field => fields.has(field))) {
    throw Object.assign(new Error('Unsupported schema'), { code: 'codex-index-unsupported' });
  }
  const title = fields.has('name') ? "COALESCE(NULLIF(name,''),title)" : 'title';
  const optional = ['agent_nickname', 'agent_path', 'source', 'recency_at_ms', 'updated_at_ms', 'is_pinned', 'attached_thread_parent_id'].filter(field => fields.has(field));
  const nativeTimes = ['recency_at_ms', 'updated_at_ms'].filter(field => fields.has(field)).map(field => `NULLIF(${field},0)`);
  const recency = nativeTimes.length ? `COALESCE(${nativeTimes.concat('updated_at*1000').join(',')})` : 'updated_at*1000';
  const cutoff = (typeof workerData.now === 'number' && Number.isFinite(workerData.now) ? workerData.now : Date.now()) - 72 * 60 * 60 * 1000;
  // 旧会话目录不读首条正文；排序与手机基本描述统一使用原生毫秒时间，不能按镜像创建时间排队。
  const preview = fields.has('first_user_message') ? `CASE WHEN ${recency}>=${Math.floor(cutoff)} THEN first_user_message ELSE '' END AS first_user_message` : "'' AS first_user_message";
  const statement = db.prepare(`SELECT id,${title} AS title,cwd,created_at,updated_at,model_provider,${preview}${optional.length ? ',' + optional.join(',') : ''} FROM threads WHERE archived=0 ORDER BY ${recency} DESC,id DESC LIMIT 200 OFFSET ?`);
  const rawOffset = Number(workerData.offset);
  /** @type {Value[]} */ const result = []; let offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.trunc(rawOffset), 0), 100000) + 0 : 0;
  while (true) {
    const rows = statement.all(offset);
    for (const row of /** @type {Value[]} */ (rows)) {
      if (typeof row.id !== 'string' || !row.id) continue;
      let source = /** @type {Value} */ ({}); try { source = JSON.parse(row.source || '{}'); } catch { /* older plain source labels */ }
      const parentId = row.attached_thread_parent_id || source.subagent?.thread_spawn?.parent_thread_id || null;
      const agentName = row.agent_nickname || source.subagent?.thread_spawn?.agent_nickname || '';
      const role = row.agent_path?.split('/').at(-1) || source.subagent?.thread_spawn?.agent_path?.split('/').at(-1) || '';
      const previewText = String(row.first_user_message || '').replace(/\s+/gu, ' ').slice(0, 160);
      const name = String(row.title || '').trim() || [agentName, role].filter(Boolean).join(' · ') || previewText.slice(0, 80) || row.id.slice(0, 8);
      result.push({ app: 'codex', id: row.id, title: name, workspace: row.cwd, createdAt: row.created_at * 1000,
        updatedAt: row.recency_at_ms || row.updated_at_ms || row.updated_at * 1000, provider: row.model_provider, parentId, agentName,
        isSubagent: !!source.subagent?.thread_spawn, preview: previewText, isPinned: row.is_pinned === 1 });
    }
    if (rows.length < 200) break; offset += rows.length;
  }
  parentPort?.postMessage({ ok: true, rows: result });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: sqliteWorkerError(dbPath, error) });
} finally {
  if (inTx) try { db?.exec('ROLLBACK'); } catch { /* ignore */ }
  db?.close();
}
