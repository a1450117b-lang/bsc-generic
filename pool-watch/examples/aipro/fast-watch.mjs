#!/usr/bin/env node
/**
 * AIPRO fast watcher: poll pair ~1.5s; trigger on ≥tpMult (tp_principal) or ≤slMult (sl_all).
 * Pool already expected open. Writes /tmp/aipro-watch/status.json; on trigger TRIGGER.json and exit 0.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

const TOKEN = '0x577bea203e5326ff6e1d4594a94167111836b286';
const PAIR = '0x9ace87f96f41aa902688362e2387fbf7b3fbb91f';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const DECIMALS = 18;
const TP_MULT = 2;
const SL_MULT = 0.9;
const COST = { 1: 0.044, 2: 0.044, 3: 0.04, 4: 0.044 };
const BAL = { 1: 550000000, 2: 550000000, 3: 500000000, 4: 550000000 };
const INTERVAL_MS = 1500;
const OUT = '/tmp/aipro-watch';
const RPCS = [
  process.env.RPC_URL,
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
  'https://bsc-dataseed1.binance.org',
].filter(Boolean);

mkdirSync(OUT, { recursive: true });

async function rpc(rpcUrl, to, data) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc');
  return j.result;
}

async function rpcBatch(rpcUrl, calls) {
  const body = calls.map((c, i) => ({
    jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'],
  }));
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('batch not array');
  return j.sort((a, b) => a.id - b.id).map((x) => {
    if (x.error) throw new Error(x.error.message || 'rpc');
    return x.result;
  });
}

let rpcUrl = RPCS[0];
async function pickRpc() {
  for (const u of RPCS) {
    try {
      await rpc(u, PAIR, '0x0902f1ac');
      rpcUrl = u;
      return u;
    } catch {}
  }
  throw new Error('no rpc');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const started = Date.now();
let lastErr = null;
let n = 0;

await pickRpc();
console.log(JSON.stringify({ event: 'start', rpc: rpcUrl, tpMult: TP_MULT, slMult: SL_MULT, ts: new Date().toISOString() }));

while (true) {
  const elapsed = Date.now() - started;
  n++;
  try {
    const [t0h, t1h, resh] = await rpcBatch(rpcUrl, [
      { to: PAIR, data: '0x0dfe1681' },
      { to: PAIR, data: '0xd21220a7' },
      { to: PAIR, data: '0x0902f1ac' },
    ]);
    const t0 = ('0x' + t0h.slice(-40)).toLowerCase();
    const t1 = ('0x' + t1h.slice(-40)).toLowerCase();
    const res = resh.slice(2);
    const r0 = Number(BigInt('0x' + res.slice(0, 64)));
    const r1 = Number(BigInt('0x' + res.slice(64, 128)));
    const wbnbRaw = t0 === WBNB ? r0 : t1 === WBNB ? r1 : 0;
    const tokRaw = t0 === TOKEN ? r0 : t1 === TOKEN ? r1 : 0;
    const wbnb = wbnbRaw / 1e18;
    const tok = tokRaw / 10 ** DECIMALS;
    const open = wbnb > 0.01;
    let priceBnb = null;
    if (tok > 0) priceBnb = wbnb / tok;

    const per = [];
    let multMax = null;
    let multMin = null;
    let sellQtyPrincipal = null;
    for (const id of [1, 2, 3, 4]) {
      const cost = COST[id];
      const bal = BAL[id];
      let valueBnb = null, mult = null, sq = null;
      if (priceBnb != null && priceBnb > 0) {
        valueBnb = bal * priceBnb;
        mult = valueBnb / cost;
        sq = Math.min(bal, cost / priceBnb);
        if (multMax == null || mult > multMax) multMax = mult;
        if (multMin == null || mult < multMin) multMin = mult;
        if (sellQtyPrincipal == null || sq > sellQtyPrincipal) sellQtyPrincipal = sq;
      }
      per.push({ id, bal, cost, valueBnb, mult, sellQtyPrincipal: sq });
    }

    const status = {
      event: open ? 'open' : 'closed',
      n, elapsedMs: elapsed, rpc: rpcUrl,
      pair: PAIR, wbnb, tok, priceBnb,
      mult: multMax, multMin, sellQtyPrincipal,
      perWallet: per,
      tpMult: TP_MULT, slMult: SL_MULT,
      action: null,
      ts: new Date().toISOString(),
    };

    if (!open) {
      writeFileSync(`${OUT}/status.json`, JSON.stringify(status, null, 2));
      if (n % 20 === 0) console.log(JSON.stringify({ event: 'heartbeat_closed', n, elapsedMs: elapsed, wbnb, ts: status.ts }));
      await sleep(INTERVAL_MS);
      continue;
    }

    const tpReady = multMax != null && multMax >= TP_MULT;
    const slReady = multMin != null && multMin > 0 && multMin <= SL_MULT;

    if (tpReady || slReady) {
      status.action = tpReady ? 'tp_principal' : 'sl_all';
      status.tpReady = tpReady;
      status.slReady = slReady;
      // prefer TP if both somehow true
      if (tpReady) status.action = 'tp_principal';
      writeFileSync(`${OUT}/status.json`, JSON.stringify(status, null, 2));
      writeFileSync(`${OUT}/TRIGGER.json`, JSON.stringify(status, null, 2));
      console.log(JSON.stringify({ event: 'TRIGGER', action: status.action, mult: multMax, multMin, wbnb, priceBnb, sellQtyPrincipal, ts: status.ts }));
      process.exit(0);
    }

    status.tpReady = false;
    status.slReady = false;
    writeFileSync(`${OUT}/status.json`, JSON.stringify(status, null, 2));
    if (n % 10 === 0) {
      console.log(JSON.stringify({ event: 'heartbeat', n, elapsedMs: elapsed, wbnb, mult: multMax, priceBnb, ts: status.ts }));
    }
    await sleep(INTERVAL_MS);
  } catch (e) {
    lastErr = String(e.message || e);
    try { await pickRpc(); } catch {}
    writeFileSync(`${OUT}/status.json`, JSON.stringify({
      event: 'error', n, err: lastErr, rpc: rpcUrl, elapsedMs: elapsed, ts: new Date().toISOString(),
    }, null, 2));
    if (n % 10 === 0) console.log(JSON.stringify({ event: 'err', n, err: lastErr }));
    await sleep(800);
  }
}
