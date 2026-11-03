#!/usr/bin/env node
/**
 * Generic BSC pool-watch check.
 * Usage: node check.mjs --dir <slug>
 * Reads /workspace/pool-watch/<slug>/config.json
 * Writes last_state.json (mirrored to store if STORE_DIR set in config).
 * Does NOT sell/transfer.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const t0 = performance.now();
const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const slug = dirIdx >= 0 ? args[dirIdx + 1] : args[0];
if (!slug) {
  console.error('Usage: node check.mjs --dir <slug>');
  process.exit(2);
}

const base = join(__dir, slug);
const cfgPath = join(base, 'config.json');
if (!existsSync(cfgPath)) {
  console.error('missing config', cfgPath);
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const TOKEN = String(cfg.token || '').toLowerCase();
const PAIR = cfg.pair ? String(cfg.pair).toLowerCase() : null;
const MINT = cfg.mint ? String(cfg.mint).toLowerCase() : null;
const WALLETS = cfg.wallets || [
  '0x0ABABF8eF7A083A580b4662d7e4e39Af32DBbEd1',
  '0xd7857acc2a935570d14a1c847c9B056eC7071fF2',
  '0x2DBf34008CEb2Cd771f573D8FF1abEc95b2D777f',
  '0x1727420C362B89B038869423e33644bcA33bbC8d',
];
const cost = cfg.costPerWallet || {}; // { "1": 0.02, ... } in BNB
const tpMult = Number(cfg.tpMult || 0);
const slPct = Number(cfg.slPct || 0);
const slMult = Number(cfg.slMult || 0);
const actions = cfg.actions || [];
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
const RPCS = [
  process.env.RPC_URL,
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
].filter(Boolean);

const encAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const decUint = (hex) => {
  if (!hex || hex === '0x') return 0n;
  try { return BigInt(hex); } catch { return 0n; }
};
const fmt = (n, d = 18) => {
  const x = n < 0n ? -n : n;
  const s = x.toString().padStart(d + 1, '0');
  const whole = s.slice(0, -d) || '0';
  const frac = s.slice(-d).replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${frac ? `${whole}.${frac}` : whole}`;
};

async function rpcCall(rpc, to, data) {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'pool-watch/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc err');
  return j.result;
}

async function pickRpc() {
  for (const rpc of RPCS) {
    try {
      await rpcCall(rpc, TOKEN, '0x313ce567');
      return rpc;
    } catch {}
  }
  throw new Error('no rpc');
}

function decodeInfo(hex) {
  // info() -> uint8,uint256,uint256,uint256,uint256
  const h = hex.slice(2);
  if (h.length < 320) return null;
  return {
    phase: Number(BigInt('0x' + h.slice(0, 64))),
    sold: Number(BigInt('0x' + h.slice(64, 128))),
    freeClaimed: Number(BigInt('0x' + h.slice(128, 192))),
    deadline: Number(BigInt('0x' + h.slice(192, 256))),
    raised: str(BigInt('0x' + h.slice(256, 320))),
  };
}

const rpc = await pickRpc();
const decimals = Number(decUint(await rpcCall(rpc, TOKEN, '0x313ce567')));
const bals = [];
for (let i = 0; i < WALLETS.length; i++) {
  const raw = decUint(await rpcCall(rpc, TOKEN, '0x70a08231' + encAddr(WALLETS[i])));
  bals.push({ id: i + 1, wallet: WALLETS[i], raw: raw.toString(), human: Number(fmt(raw, decimals)) });
}

let pair = { address: PAIR, r0: 0, r1: 0, token0: null, token1: null, wbnb: 0, tok: 0, priceBnb: null };
if (PAIR) {
  try {
    const t0 = '0x' + (await rpcCall(rpc, PAIR, '0x0dfe1681')).slice(-40);
    const t1 = '0x' + (await rpcCall(rpc, PAIR, '0xd21220a7')).slice(-40);
    const res = (await rpcCall(rpc, PAIR, '0x0902f1ac')).slice(2);
    const r0 = Number(BigInt('0x' + res.slice(0, 64)));
    const r1 = Number(BigInt('0x' + res.slice(64, 128)));
    const wbnb = t0.toLowerCase() === WBNB ? r0 : t1.toLowerCase() === WBNB ? r1 : 0;
    const tok = t0.toLowerCase() === TOKEN ? r0 : t1.toLowerCase() === TOKEN ? r1 : 0;
    const priceBnb = tok > 0 ? (wbnb / 1e18) / (tok / 10 ** decimals) : null;
    pair = { address: PAIR, token0: t0, token1: t1, r0, r1, wbnb: wbnb / 1e18, tok: tok / 10 ** decimals, priceBnb };
  } catch (e) {
    pair.error = String(e.message || e);
  }
}

let info = null;
const infoTarget = MINT || TOKEN;
try {
  // keccak('info()')[:4] = 0x370158ea often; compute via eth_call try known
  const sels = ['0x370158ea', '0x5a9b85ee']; // common; also try from cfg
  if (cfg.infoSelector) sels.unshift(cfg.infoSelector);
  for (const sel of sels) {
    try {
      const out = await rpcCall(rpc, infoTarget, sel);
      const d = decodeInfo(out);
      if (d && d.phase >= 0 && d.phase <= 10) { info = { ...d, selector: sel }; break; }
    } catch {}
  }
} catch {}

// BNB/USDT via getAmountsOut 1 BNB
let bnbUsdt = null;
try {
  const amt = (10n ** 18n).toString(16).padStart(64, '0');
  const data =
    '0xd06ca61f' +
    amt +
    (0x40).toString(16).padStart(64, '0') +
    (2).toString(16).padStart(64, '0') +
    encAddr(WBNB) +
    encAddr(USDT);
  const out = (await rpcCall(rpc, ROUTER, data)).slice(2);
  const a1 = BigInt('0x' + out.slice(192, 256));
  bnbUsdt = Number(a1) / 1e18;
} catch {}

const open = Boolean(
  (info && info.phase >= 3) ||
    (pair.wbnb && pair.wbnb > 0.01) ||
    cfg.forceOpen
);

const perWallet = bals.map((b) => {
  const cBnb = Number(cost[String(b.id)] ?? cost[b.id] ?? cfg.defaultCostBnb ?? 0);
  const valueBnb = pair.priceBnb != null ? b.human * pair.priceBnb : null;
  const mult = valueBnb != null && cBnb > 0 ? valueBnb / cBnb : null;
  let sellQtyPrincipal = null;
  if (pair.priceBnb && pair.priceBnb > 0 && cBnb > 0) {
    sellQtyPrincipal = Math.min(b.human, cBnb / pair.priceBnb);
  }
  return { ...b, costBnb: cBnb, valueBnb, mult, sellQtyPrincipal };
});

let openRefPrice = cfg.openRefPriceBnb || null;
const statePath = join(base, 'last_state.json');
let prev = {};
try { prev = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
if (open && pair.priceBnb && !openRefPrice) {
  openRefPrice = prev.openRefPriceBnb || pair.priceBnb;
}

const dropPct =
  openRefPrice && pair.priceBnb != null
    ? ((pair.priceBnb - openRefPrice) / openRefPrice) * 100
    : null;

const slByMult = slMult > 0 && perWallet.some((p) => p.mult != null && p.mult > 0 && p.mult <= slMult);
const triggers = {
  open,
  tpReady: tpMult > 0 && perWallet.some((p) => p.mult != null && p.mult >= tpMult),
  slReady: slByMult || (slPct > 0 && dropPct != null && dropPct <= -slPct),
  canTransfer: open,
};

const out = {
  ok: true,
  slug,
  token: TOKEN,
  pair: pair.address,
  mint: MINT,
  decimals,
  rpc,
  info,
  open,
  openRefPriceBnb: openRefPrice,
  priceBnb: pair.priceBnb,
  dropPct,
  bnbUsdt,
  pairLiqWbnb: pair.wbnb,
  actions,
  tpMult,
  slPct,
  slMult,
  wallets: perWallet,
  triggers,
  elapsedMs: Math.round(performance.now() - t0),
  ts: new Date().toISOString(),
};

mkdirSync(base, { recursive: true });
writeFileSync(statePath, JSON.stringify({ ...out, openRefPriceBnb: openRefPrice }, null, 2));
if (cfg.storeDir) {
  try {
    mkdirSync(cfg.storeDir, { recursive: true });
    copyFileSync(statePath, join(cfg.storeDir, 'last_state.json'));
    copyFileSync(cfgPath, join(cfg.storeDir, 'config.json'));
  } catch {}
}
console.log(JSON.stringify(out, null, 2));
