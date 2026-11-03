#!/usr/bin/env node
/**
 * Fast Mars-like invite-train: discover + encode 4 free mintPaid calldatas + parallel eth_call.
 * Usage: node invite-train.mjs <url|0x> [--ref=0x..] [--dry] [--mars]
 * eth_call only — never broadcasts.
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

const t0 = performance.now();
const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--')) || '';
const dry = argv.includes('--dry');
const forceMars = argv.includes('--mars');
const refArg = (argv.find((a) => a.startsWith('--ref=')) || '').slice(6);

const WALLETS = [
  '0x0ABABF8eF7A083A580b4662d7e4e39Af32DBbEd1',
  '0xd7857acc2a935570d14a1c847c9B056eC7071fF2',
  '0x2DBf34008CEb2Cd771f573D8FF1abEc95b2D777f',
  '0x1727420C362B89B038869423e33644bcA33bbC8d',
];

const ZERO = '0x0000000000000000000000000000000000000000';
const RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
];

const SEL = {
  quote: '0x0b39ed47', // quote(address)
  totalMinted: '0xa2309ff8',
  mintPaid: '0x1075abb2', // mintPaid((uint8,uint8,uint256,uint256,uint256,address))
};

const isAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(s || '');
const encAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const encUint = (n) => BigInt(n).toString(16).padStart(64, '0');
const UA = { 'user-agent': 'Mozilla/5.0', accept: '*/*' };

function resolveRef(raw) {
  if (!raw) return ZERO;
  // site 24-hex refs are NOT addresses — skip after quick reject
  if (isAddr(raw)) return raw;
  return ZERO;
}

async function fetchText(url, ms = 1500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: UA, redirect: 'follow' });
    if (!r.ok) return { ok: false, status: r.status, text: '' };
    return { ok: true, status: r.status, text: await r.text() };
  } catch {
    return { ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(t);
  }
}

function parseConfig(text) {
  const out = { mint: null };
  try {
    const j = JSON.parse(text);
    if (typeof j.nft === 'string' && isAddr(j.nft)) out.mint = j.nft;
    if (typeof j.mainnet?.nft === 'string' && isAddr(j.mainnet.nft)) out.mint = j.mainnet.nft;
    if (typeof j.mint === 'string' && isAddr(j.mint)) out.mint = j.mint;
    if (typeof j.mint === 'object' && j.mint?.address && isAddr(j.mint.address)) out.mint = j.mint.address;
    if (j.contracts?.mint && isAddr(j.contracts.mint)) out.mint = j.contracts.mint;
    if (j.projectAddress && isAddr(j.projectAddress)) out.mint = j.projectAddress;
    if (j.addresses?.mint && isAddr(j.addresses.mint)) out.mint = j.addresses.mint;
  } catch {
    const mintM =
      text.match(/["']nft["']\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i) ||
      text.match(/["']mint["']\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i) ||
      text.match(/\bmint\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i);
    if (mintM) out.mint = mintM[1];
  }
  return out;
}

async function discover(urlOrAddr) {
  if (isAddr(urlOrAddr)) return { mint: urlOrAddr, sources: ['cli'] };
  let base;
  try {
    const u = new URL(urlOrAddr.includes('://') ? urlOrAddr : 'https://' + urlOrAddr);
    base = `${u.protocol}//${u.host}`;
  } catch {
    base = 'https://' + String(urlOrAddr).replace(/^\/\//, '');
  }
  const wave1 = [
    '/chain/config.json',
    '/mint/chain/config.json',
    '/config.json',
    '/deployment.json',
    '/assets/config.js',
    '/config.js',
    '/assets/deployment.json',
  ];
  const r1 = await Promise.all(wave1.map(async (p) => ({ p, ...(await fetchText(base + p, 1500)) })));
  let mint = null;
  const sources = [];
  for (const r of r1) {
    if (!r.ok || !r.text) continue;
    const cfg = parseConfig(r.text);
    if (cfg.mint && !mint) {
      mint = cfg.mint;
      sources.push(r.p);
    }
  }
  if (!mint) {
    const wave2 = ['/', '/assets/chain.js', '/assets/app.js'];
    const r2 = await Promise.all(wave2.map(async (p) => ({ p, ...(await fetchText(base + p, 1500)) })));
    for (const r of r2) {
      if (!r.ok || !r.text) continue;
      const cfg = parseConfig(r.text);
      if (cfg.mint && !mint) {
        mint = cfg.mint;
        sources.push(r.p);
      }
    }
  }
  return { base, mint, sources };
}

let rpcUrl = RPCS[0];
async function rpcBatch(calls, timeoutMs = 5000) {
  let last;
  for (const url of RPCS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }));
      const r = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: { ...UA, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error('not batch');
      const byId = new Map(j.map((x) => [x.id, x]));
      const out = calls.map((_, id) => {
        const x = byId.get(id);
        if (!x) return { error: 'missing' };
        if (x.error) return { error: x.error.message || JSON.stringify(x.error) };
        return { result: x.result };
      });
      rpcUrl = url;
      return out;
    } catch (e) {
      last = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw last || new Error('rpc batch fail');
}

/** Encode mintPaid((uint8,uint8,uint256,uint256,uint256,address)) — static tuple inline */
function encodeMintPaidFree({ ordinal, inviter, deadline }) {
  return (
    SEL.mintPaid +
    encUint(ordinal) +
    encUint(0) + // method=0 USDT (free first)
    encUint(0) + // maxAmount
    encUint(0) + // maxRandomnessFeeWei
    encUint(deadline) +
    encAddr(inviter)
  );
}

function parseQuoteMinted(hex) {
  // returns (bytes32 key, uint8 minted, uint256 price, uint8 remaining)
  if (!hex || hex === '0x' || hex.length < 2 + 64 * 4) return null;
  const minted = Number(BigInt('0x' + hex.slice(2 + 64, 2 + 128)));
  const remaining = Number(BigInt('0x' + hex.slice(2 + 64 * 3, 2 + 64 * 4)));
  return { minted, remaining };
}

async function main() {
  if (!target) {
    console.error('usage: node invite-train.mjs <url|0x> [--ref=0x..] [--dry] [--mars]');
    process.exit(2);
  }

  const w1Ref = resolveRef(refArg);
  const disc = await discover(target);
  const mint = disc.mint;
  if (!mint) {
    const out = {
      ok: false,
      error: 'mint/nft not found',
      elapsedMs: Math.round(performance.now() - t0),
      disc,
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }

  // Detect Mars-like: quote(address) works, or --mars
  const quoteCalls = WALLETS.map((w) => ({
    method: 'eth_call',
    params: [{ to: mint, data: SEL.quote + encAddr(w) }, 'latest'],
  }));
  quoteCalls.push({ method: 'eth_call', params: [{ to: mint, data: SEL.totalMinted }, 'latest'] });
  quoteCalls.push({ method: 'eth_blockNumber', params: [] });

  let batch;
  try {
    batch = await rpcBatch(quoteCalls, 5000);
  } catch (e) {
    console.log(
      JSON.stringify(
        { ok: false, error: 'rpc fail: ' + String(e.message || e), mint, elapsedMs: Math.round(performance.now() - t0) },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const quotes = WALLETS.map((_, i) => {
    const r = batch[i];
    if (r.error || !r.result) return null;
    return parseQuoteMinted(r.result);
  });
  const marsLike = forceMars || quotes.some((q) => q !== null);
  if (!marsLike) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'not Mars-like (quote(address) failed); pass --mars to force',
          mint,
          elapsedMs: Math.round(performance.now() - t0),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  let now = Math.floor(Date.now() / 1000);
  const bn = batch[WALLETS.length + 1];
  // deadline = now+300; wall clock is fine for dry encoding
  const deadline = now + 300;

  // Closed loop: W1←W4, W2←W1, W3←W2, W4←W3 (互拉默认闭环; --ref 外链不打断自拉环)
  const inviters = [WALLETS[3], WALLETS[0], WALLETS[1], WALLETS[2]];

  const train = WALLETS.map((wallet, i) => {
    const q = quotes[i];
    const minted = q ? q.minted : 0;
    const ordinal = minted + 1;
    const inviter = inviters[i];
    const data = encodeMintPaidFree({ ordinal, inviter, deadline });
    return {
      wallet,
      inviter,
      ordinal,
      minted,
      remaining: q ? q.remaining : null,
      data,
      value: '0',
      simOk: false,
      error: null,
    };
  });

  // Parallel eth_call sim all 4
  const simBatch = await rpcBatch(
    train.map((t) => ({
      method: 'eth_call',
      params: [{ to: mint, from: t.wallet, data: t.data, value: '0x0' }, 'latest'],
    })),
    6000,
  );

  for (let i = 0; i < train.length; i++) {
    const s = simBatch[i] || {};
    if (!s.error && s.result !== undefined) {
      train[i].simOk = true;
      train[i].error = null;
    } else {
      train[i].simOk = false;
      train[i].error = s.error ? String(s.error).slice(0, 160) : 'unknown';
    }
  }

  const plan = {
    mint,
    paid: false,
    deadline,
    rpc: rpcUrl,
    train: train.map((t, i) => ({
      wallet: i + 1,
      from: t.wallet,
      to: mint,
      value: '0',
      inputData: t.data,
      inviter: t.inviter,
      ordinal: t.ordinal,
      simOk: t.simOk,
      error: t.error,
    })),
  };
  writeFileSync('/tmp/invite-train-plan.json', JSON.stringify(plan, null, 2));

  const out = {
    ok: true,
    dry,
    mint,
    paid: false,
    sources: disc.sources,
    refResolved: w1Ref,
    rpc: rpcUrl,
    train: train.map((t) => ({
      wallet: t.wallet,
      inviter: t.inviter,
      ordinal: t.ordinal,
      data: t.data,
      simOk: t.simOk,
      error: t.error,
    })),
    simOk: train.filter((t) => t.simOk).length,
    planPath: '/tmp/invite-train-plan.json',
    elapsedMs: Math.round(performance.now() - t0),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.log(
    JSON.stringify({ ok: false, error: String(e.stack || e), elapsedMs: Math.round(performance.now() - t0) }, null, 2),
  );
  process.exit(1);
});
