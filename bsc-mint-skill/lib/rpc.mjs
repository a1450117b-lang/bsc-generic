// Round-robin + failover JSON-RPC client with batching. Read-only methods only.
import { UA, now } from './util.mjs';
export const RPCS = (process.env.BSC_RPCS ? process.env.BSC_RPCS.split(',') : [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
]);
const ALLOWED = new Set(['eth_call', 'eth_estimateGas', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs', 'eth_getBalance',
  'eth_blockNumber', 'eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber',
  'eth_simulateV1', 'eth_gasPrice', 'eth_getTransactionCount']);
const health = new Map(RPCS.map((u) => [u, { fails: 0, okMs: 0, n: 0, cooldownUntil: 0 }]));
let rr = 0;
export const stats = { requests: 0, calls: 0, failovers: 0, used: {} };
const PRIMARY = Number(process.env.BSC_RPC_PRIMARY || 3); // round-robin among first N; rest are failover only
function order() {
  const t = Date.now();
  const live = RPCS.filter((u) => health.get(u).cooldownUntil <= t);
  const dead = RPCS.filter((u) => health.get(u).cooldownUntil > t);
  const prim = live.filter((u) => RPCS.indexOf(u) < PRIMARY), rest = live.filter((u) => RPCS.indexOf(u) >= PRIMARY);
  const start = rr++ % Math.max(1, prim.length);
  return [...prim.slice(start), ...prim.slice(0, start), ...rest, ...dead];
}
const isTransport = (e) => e && (e.code === 15 || e.code === -32005 || e.code === 429 || /rate limit|limit exceeded|too many|timeout|header not found|missing trie|unavailable|internal error|upgrade to paid/i.test(e.message || ''));
async function post(url, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', signal: ac.signal, headers: { ...UA, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
/** batch([{method, params}]) -> [{result}|{error:{message,data,code}}]. Failover on transport errors. */
export async function batch(calls, { timeoutMs = 4500, chunk = 25, prefer } = {}) {
  for (const c of calls) if (!ALLOWED.has(c.method)) throw new Error('RPC method not allowed (read-only toolkit): ' + c.method);
  const chunks = [];
  for (let i = 0; i < calls.length; i += chunk) chunks.push(calls.slice(i, i + chunk));
  const outs = await Promise.all(chunks.map((cs) => batchOne(cs, timeoutMs, prefer)));
  return outs.flat();
}
async function batchOne(calls, timeoutMs, prefer) {
  let lastErr;
  const urls = prefer ? [prefer, ...order().filter((u) => u !== prefer)] : order();
  for (const url of urls) {
    const h = health.get(url) || { fails: 0 };
    const t0 = now();
    try {
      stats.requests++; stats.calls += calls.length;
      const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }));
      let j = await post(url, body, timeoutMs);
      if (!Array.isArray(j)) { if (j && j.error && isTransport(j.error)) throw new Error(j.error.message); throw new Error('no batch support'); }
      const byId = new Map(j.map((x) => [x.id, x]));
      const out = calls.map((_, id) => {
        const x = byId.get(id);
        if (!x) return { error: { message: 'missing' } };
        if (x.error) return { error: { message: x.error.message || String(x.error), data: x.error.data, code: x.error.code } };
        return { result: x.result };
      });
      // if every item is a transport-ish error → failover
      const tErr = out.filter((o) => o.error && isTransport(o.error));
      if (tErr.length && tErr.length >= Math.ceil(out.length / 2)) throw new Error('transport errors: ' + tErr[0].error.message);
      // retry the few transport-failed items once elsewhere
      if (tErr.length) {
        const idx = out.map((o, i) => (o.error && isTransport(o.error) ? i : -1)).filter((i) => i >= 0);
        const other = RPCS.find((u) => u !== url && health.get(u).cooldownUntil <= Date.now());
        if (other) {
          try {
            const r2 = await batchOne(idx.map((i) => calls[i]), timeoutMs, other);
            idx.forEach((i, k) => (out[i] = r2[k]));
          } catch {}
        }
      }
      h.fails = 0; h.n++; h.okMs = Math.round(now() - t0);
      stats.used[url] = (stats.used[url] || 0) + 1;
      return out;
    } catch (e) {
      lastErr = e; stats.failovers++;
      h.fails++; h.cooldownUntil = Date.now() + Math.min(60000, 3000 * h.fails);
    }
  }
  throw lastErr || new Error('all RPCs failed');
}
export async function call(method, params, opts) {
  const [r] = await batch([{ method, params }], opts);
  return r;
}
export const ethCall = (to, data, from, extra = {}) => ({ method: 'eth_call', params: [{ to, data, ...(from ? { from } : {}), ...extra.tx }, 'latest', ...(extra.override ? [extra.override] : [])] });
/** getLogs with range splitting (bsc-dataseed limits ranges) */
export async function getLogsChunked(filter, from, to, step = 1000, maxChunks = 8) {
  const calls = [];
  for (let b = to; b > from && calls.length < maxChunks; b -= step) {
    const lo = Math.max(from, b - step + 1);
    calls.push({ method: 'eth_getLogs', params: [{ ...filter, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + b.toString(16) }] });
  }
  const res = await batch(calls, { chunk: 4, timeoutMs: 9000 });
  const logs = [];
  for (const r of res) if (Array.isArray(r.result)) logs.push(...r.result);
  return { logs, errors: res.filter((r) => r.error).map((r) => r.error.message) };
}
// Logs: bsc-dataseed* reject eth_getLogs ("limit exceeded"); use log-capable endpoints.
export const LOG_RPCS = (process.env.BSC_LOG_RPCS ? process.env.BSC_LOG_RPCS.split(',') : ['https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org']);
export async function recentLogs(filter, latest, range = 3000) {
  const errors = [];
  for (const url of LOG_RPCS) {
    let r = url.includes('drpc') ? Math.min(range, 50) : range;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const j = await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ ...filter, fromBlock: '0x' + (latest - r).toString(16), toBlock: '0x' + latest.toString(16) }] }, 6000);
        if (Array.isArray(j.result)) return { logs: j.result, range: r, url };
        const m = j.error?.message || 'err';
        errors.push(m.slice(0, 80));
        if (/max results|too many|exceed/i.test(m)) { r = Math.max(10, Math.floor(r / 8)); continue; }
        break;
      } catch (e) { errors.push(String(e.message || e).slice(0, 60)); break; }
    }
  }
  return { logs: [], errors };
}
