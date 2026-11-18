import { get } from 'node:https';
import { isIP } from 'node:net';

const MAX_DOH_BYTES = 16_384;

/** @param {Response} response @returns {Promise<string|null>} */
async function readBoundedText(response) {
  const length = response.headers?.get?.('content-length');
  if (length !== null && Number.isFinite(Number(length)) && Number(length) > MAX_DOH_BYTES) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    return null;
  }
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > MAX_DOH_BYTES ? null : text;
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */ const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_DOH_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/** Checks only the owned public tunnel; the machine's DNS and other applications are never changed.
 * @param {string} origin @param {{fetch?:typeof globalThis.fetch,dohUrl?:string,httpsGet?:typeof get}} [deps] @returns {Promise<boolean>} */
export async function tunnelHealth(origin, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const dohUrl = deps.dohUrl ?? 'https://cloudflare-dns.com/dns-query';
  const httpsGet = deps.httpsGet ?? get;
  /** @type {URL} */ let url;
  try { url = new URL(origin); } catch { return false; }
  const healthUrl = new URL('/health', url).toString();
  try {
    const direct = await fetchFn(healthUrl, { signal: AbortSignal.timeout(3000) });
    try { await direct.body?.cancel(); } catch { /* ignore */ }
    if (direct.ok) return true;
  } catch { /* A failed system resolver/route is checked against the same TLS hostname below. */ }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.trycloudflare.com')) return false;
  // 本机 DNS 对已存在的 Quick Tunnel 返回 NXDOMAIN；仅这个 Codelync 探测使用 DoH，TLS 仍校验原 hostname。
  /** @type {{Status?:number,Answer?:{type:number,data:string}[]}|null} */ let data = null;
  try {
    const response = await fetchFn(`${dohUrl}?name=${encodeURIComponent(url.hostname)}&type=A`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return false;
    }
    const text = await readBoundedText(response);
    if (!text) return false;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    data = parsed;
  } catch {
    return false;
  }
  const address = data?.Status === 0 && Array.isArray(data.Answer)
    ? data.Answer.find(answer => answer && typeof answer === 'object' && answer.type === 1 && typeof answer.data === 'string' && isIP(answer.data) === 4)?.data
    : null;
  if (!address) return false;
  return new Promise(resolveHealth => {
    let settled = false;
    /** @param {boolean} ok */
    const finish = ok => { if (!settled) { settled = true; resolveHealth(ok); } };
    const request = httpsGet(healthUrl, { servername: url.hostname,
      lookup: (_host, options, callback) => {
        const cb = /** @type {any} */ (callback);
        if (typeof options === 'object' && options.all) cb(null, [{ address, family: 4 }]); else cb(null, address, 4);
      } }, result => { result.resume(); finish(result.statusCode === 200); });
    request.setTimeout(5000, () => { request.destroy(Error('tunnel-health-timeout')); finish(false); });
    request.on('error', () => finish(false));
  });
}
