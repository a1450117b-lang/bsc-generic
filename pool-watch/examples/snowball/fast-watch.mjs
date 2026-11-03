#!/usr/bin/env node
/**
 * Fast Snowball pool watcher: poll pair reserves ~every 2s, sell on open.
 * Writes status to /tmp/snowball-watch/status.json
 * On trigger writes /tmp/snowball-watch/TRIGGER.json and exits 0 with action.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

const TOKEN = '0x79b5d86089a29a65fac3278572f00c8fadc361fb';
const PAIR = '0x8c18cf56c5cce496d88752528aca95a099a94bc1';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
const DECIMALS = 18;
const COST = 0.022;
const TP_MULT = 2;
const BAL_HUMAN = 550000000; // each wallet
const INTERVAL_MS = 1500;
const REPORT_CLOSED_MS = 15 * 60 * 1000;
const STOP_MS = 30 * 60 * 1000;
const OUT = '/tmp/snowball-watch';
const RPCS = [
  process.env.RPC_URL,
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
  'https://bsc-dataseed1.binance.org',
].filter(Boolean);

mkdirSync(OUT, { recursive: true });

const encAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

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
let reported15 = false;
let lastErr = null;
let n = 0;

await pickRpc();
console.log(JSON.stringify({ event: 'start', rpc: rpcUrl, ts: new Date().toISOString() }));

while (true) {
  const elapsed = Date.now() - started;
  if (elapsed >= STOP_MS) {
    const st = { event: 'stop_30m', open: false, elapsedMs: elapsed, ts: new Date().toISOString() };
    writeFileSync(`${OUT}/status.json`, JSON.stringify(st, null, 2));
    console.log(JSON.stringify(st));
    process.exit(2);
  }
  if (elapsed >= REPORT_CLOSED_MS && !reported15) {
    reported15 = true;
    const st = { event: 'still_closed_15m', open: false, elapsedMs: elapsed, ts: new Date().toISOString() };
    writeFileSync(`${OUT}/status.json`, JSON.stringify(st, null, 2));
    writeFileSync(`${OUT}/REPORT_15M.json`, JSON.stringify(st, null, 2));
    console.log(JSON.stringify(st));
  }

  n++;
  try {
    // batch: token0, token1, getReserves
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
    let valueBnb = null;
    let mult = null;
    let sellQtyPrincipal = null;
    if (tok > 0) {
      priceBnb = wbnb / tok;
      valueBnb = BAL_HUMAN * priceBnb;
      mult = valueBnb / COST;
      sellQtyPrincipal = Math.min(BAL_HUMAN, COST / priceBnb);
    }

    const status = {
      event: open ? 'open' : 'closed',
      n, elapsedMs: elapsed, rpc: rpcUrl,
      pair: PAIR, wbnb, tok, priceBnb, valueBnb, mult, sellQtyPrincipal,
      tpMult: TP_MULT,
      action: null,
      ts: new Date().toISOString(),
    };

    if (!open) {
      writeFileSync(`${OUT}/status.json`, JSON.stringify(status, null, 2));
      if (n % 20 === 0) console.log(JSON.stringify({ event: 'heartbeat', n, elapsedMs: elapsed, wbnb, ts: status.ts }));
      await sleep(INTERVAL_MS);
      continue;
    }

    // OPEN — decide sell
    const tpReady = mult != null && mult >= TP_MULT;
    status.action = tpReady ? 'tp_principal' : 'sell_all';
    status.tpReady = tpReady;
    writeFileSync(`${OUT}/status.json`, JSON.stringify(status, null, 2));
    writeFileSync(`${OUT}/TRIGGER.json`, JSON.stringify(status, null, 2));
    console.log(JSON.stringify({ event: 'TRIGGER', ...status }));
    process.exit(0);
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
