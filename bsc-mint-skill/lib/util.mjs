// Shared constants + helpers (read-only toolkit)
import { ethers } from 'ethers';
import { performance } from 'node:perf_hooks';
export { ethers };
export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const WALLETS = [
  { id: 'W1', addr: '0x0ABABF8eF7A083A580b4662d7e4e39Af32DBbEd1' },
  { id: 'W2', addr: '0xd7857acc2a935570d14a1c847c9B056eC7071fF2' },
  { id: 'W3', addr: '0x2DBf34008CEb2Cd771f573D8FF1abEc95b2D777f' },
  { id: 'W4', addr: '0x1727420C362B89B038869423e33644bcA33bbC8d' },
];
export const USDT = '0x55d398326f99059fF775485246999027B3197955';
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
export const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
export const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
export const AGENT_ID_REGISTRY = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const KNOWN = {
  [USDT.toLowerCase()]: 'USDT',
  [WBNB.toLowerCase()]: 'WBNB',
  [ROUTER.toLowerCase()]: 'PancakeRouterV2',
  [FACTORY.toLowerCase()]: 'PancakeFactoryV2',
  '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': 'PancakeRouterV3',
  '0x1b81d678ffb9c0263b24a97847620c99d213eb14': 'PancakeV3SwapRouter',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD',
  [AGENT_ID_REGISTRY.toLowerCase()]: 'SPACE-ID AgentID',
  '0x000000000000000000000000000000000000dead': 'DEAD',
  [ZERO]: 'ZERO',
  '0xca11bde05977b3631167028862be2a173976ca11': 'Multicall3',
};
export const isAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(String(s || ''));
export const lc = (s) => String(s || '').toLowerCase();
export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '-');
export const now = () => performance.now();
export function fmtUnits(v, d = 18, maxFrac = 6) {
  if (v === null || v === undefined) return '-';
  let s = ethers.formatUnits(BigInt(v), d);
  if (s.includes('.')) {
    const [a, b] = s.split('.');
    const bb = b.slice(0, maxFrac).replace(/0+$/, '');
    s = bb ? `${a}.${bb}` : a;
  }
  return s;
}
export const keccak = (hexOrBytes) => ethers.keccak256(hexOrBytes);
export const sel = (sig) => ethers.id(sig).slice(0, 10);
export const pad32 = (h) => h.replace(/^0x/, '').padStart(64, '0');
export const encAddr = (a) => pad32(lc(a));
export const encUint = (n) => BigInt(n).toString(16).padStart(64, '0');
export const decUint = (hex) => (!hex || hex === '0x' ? null : BigInt(hex.slice(0, 66)));
export const decAddr = (hex) => (hex && hex.length >= 66 ? ethers.getAddress('0x' + hex.slice(26, 66)) : null);
export const toHex = (n) => '0x' + BigInt(n).toString(16);
export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 0;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
export function timer() {
  const t0 = now();
  const stages = {};
  let last = t0;
  return {
    mark(name) { const t = now(); stages[name] = Math.round(t - last); last = t; return stages[name]; },
    add(name, ms) { stages[name] = (stages[name] || 0) + Math.round(ms); },
    total() { return Math.round(now() - t0); },
    stages,
  };
}
export async function withTimeout(p, ms, fallback = null) {
  let t;
  return Promise.race([p, new Promise((r) => (t = setTimeout(() => r(fallback), ms)))]).finally(() => clearTimeout(t));
}
export const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', accept: '*/*' };
export async function fetchText(url, ms = 4000, maxBytes = 4_000_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const t0 = now();
  try {
    const r = await fetch(url, { signal: ac.signal, headers: UA, redirect: 'follow' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) return { ok: false, status: r.status, url, ct, text: '', ms: Math.round(now() - t0) };
    let text = await r.text();
    if (text.length > maxBytes) text = text.slice(0, maxBytes);
    return { ok: true, status: r.status, url: r.url || url, ct, text, ms: Math.round(now() - t0) };
  } catch (e) {
    return { ok: false, status: 0, url, ct: '', text: '', err: String(e.name || e), ms: Math.round(now() - t0) };
  } finally { clearTimeout(t); }
}
export function bigJson(o) {
  return JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
