#!/usr/bin/env node
/**
 * Fast mint check + 4-wallet eth_call sim (BSC).
 * Usage: node check.mjs <url|0x> [--shares=10]
 * Target: ≤8s wall.
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

const t0 = performance.now();
const target = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';
const SHARES = BigInt((process.argv.find((a) => a.startsWith('--shares=')) || '--shares=10').split('=')[1]);

const WALLETS = [
  '0x0ABABF8eF7A083A580b4662d7e4e39Af32DBbEd1',
  '0xd7857acc2a935570d14a1c847c9B056eC7071fF2',
  '0x2DBf34008CEb2Cd771f573D8FF1abEc95b2D777f',
  '0x1727420C362B89B038869423e33644bcA33bbC8d',
];

const RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
];

const USDT = '0x55d398326f99059fF775485246999027B3197955';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';

const pad = (n) => BigInt(n).toString(16).padStart(64, '0');
const encAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const encUint = (n) => pad(n);
const encBytes32 = (b) => (b || '0x').replace(/^0x/, '').padStart(64, '0');
const decUint = (hex) => (!hex || hex === '0x' ? 0n : BigInt(hex.slice(0, 66)));
const fmt = (n, d = 18) => {
  const s = n.toString().padStart(d + 1, '0');
  const whole = s.slice(0, -d) || '0';
  const frac = s.slice(-d).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
const isAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(s || '');
const UA = { 'user-agent': 'Mozilla/5.0', accept: '*/*' };

async function fetchText(url, ms = 2500) {
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

let rpcUrl = RPCS[0];
async function rpcBatch(calls, timeoutMs = 6000) {
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

function parseConfig(text) {
  const out = { mint: null, token: null, brand: null, priceBnb: null, projectAddress: null };
  const activeM = text.match(/const\s+active\s*=\s*["'](\w+)["']/);
  const active = activeM ? activeM[1] : null;
  if (active) {
    const idx = text.indexOf(active + ':');
    if (idx >= 0) {
      const slice = text.slice(idx, idx + 1500);
      const mintM = slice.match(/mint\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i);
      const tokenM = slice.match(/token\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i);
      if (mintM) out.mint = mintM[1];
      if (tokenM) out.token = tokenM[1];
    }
  }
  const pa = text.match(/projectAddress\s*[:=]\s*["'](0x[a-fA-F0-9]{40})["']/i);
  if (pa) out.projectAddress = pa[1];
  if (!out.mint) {
    const mintM =
      text.match(/["']mint["']\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i) ||
      text.match(/\bmint\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i);
    if (mintM) out.mint = mintM[1];
  }
  if (!out.token) {
    const tokenM =
      text.match(/["']token["']\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i) ||
      text.match(/\btoken\s*:\s*["'](0x[a-fA-F0-9]{40})["']/i);
    if (tokenM) out.token = tokenM[1];
  }
  if (out.projectAddress && !out.mint) out.mint = out.projectAddress;
  const brandM = text.match(/brand\s*:\s*["']([^"']+)["']/);
  if (brandM) out.brand = brandM[1];
  // bnbdog PRICE = 0.003e18 style
  const priceM = text.match(/PRICE\s*[:=]\s*(\d+n?|0x[a-fA-F0-9]+|\d+e\d+)/);
  if (priceM) out.priceRaw = priceM[1];
  // Cats / launchpad app.js: claimFree + FREE tier + USDT mint selector
  if (/claimFree\s*:\s*["']0xf366afc9["']/i.test(text) || /claimFree\(\)/.test(text)) {
    out.claimFree = '0xf366afc9';
  }
  const freeCapM = text.match(/\bconst\s+FREE\s*=\s*(\d+)/) || text.match(/FREE\s*=\s*(\d+)/);
  if (freeCapM) out.freeCap = Number(freeCapM[1]);
  if (/mint\s*:\s*["']0x836a1040["']/i.test(text)) out.mintUsdtSel = '0x836a1040';
  if (/mintWithBnb\s*:\s*["']0xe38fd349["']/i.test(text)) out.hasMintWithBnb = true;
  try {
    const j = JSON.parse(text);
    const pick = (o) => {
      if (!o || typeof o !== 'object') return;
      if (o.mint) out.mint = o.mint;
      if (o.token) out.token = o.token;
      if (o.projectAddress) out.mint = o.projectAddress;
      if (o.addresses?.mint) out.mint = o.addresses.mint;
      if (o.addresses?.token) out.token = o.addresses.token;
    };
    pick(j);
    // Mars / NFT-centric configs expose `nft` as the mint contract
    if (typeof j.nft === 'string' && /^0x[a-fA-F0-9]{40}$/.test(j.nft)) out.mint = j.nft;
    if (typeof j.mainnet?.nft === 'string' && /^0x[a-fA-F0-9]{40}$/.test(j.mainnet.nft)) out.mint = j.mainnet.nft;
    pick(j.mainnet);
    pick(j.networks?.mainnet);
    pick(j.networks?.mainnet?.addresses && { addresses: j.networks.mainnet.addresses });
    // longxia deployment.json often { mint: { address }, token: { address } } or flat
    if (j.contracts?.mint) out.mint = j.contracts.mint;
    if (j.contracts?.token) out.token = j.contracts.token;
    if (typeof j.mint === 'object' && j.mint?.address) out.mint = j.mint.address;
    if (typeof j.token === 'object' && j.token?.address) out.token = j.token.address;
    if (typeof j.tokenAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(j.tokenAddress)) out.token = j.tokenAddress;
    // launchpad/mint contract MUST win over tokenAddress / generic mint field
    if (typeof j.launchpadAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(j.launchpadAddress)) out.mint = j.launchpadAddress;
    if (typeof j.mintContractAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(j.mintContractAddress)) out.mint = j.mintContractAddress;
    if (j.basePriceWei) out.priceRaw = String(j.basePriceWei);
    if (Array.isArray(j.rpcUrls) && j.rpcUrls.length) out.rpcs = j.rpcUrls;
  } catch {}
  return out;
}

async function discover(urlOrAddr) {
  if (isAddr(urlOrAddr)) return { mint: urlOrAddr, token: null, brand: null, sources: ['cli'], meta: {} };
  let base;
  try {
    const u = new URL(urlOrAddr.includes('://') ? urlOrAddr : 'https://' + urlOrAddr);
    base = `${u.protocol}//${u.host}`;
  } catch {
    base = 'https://' + String(urlOrAddr).replace(/^\/\//, '');
  }
  // wave1 critical only
  const wave1 = ['/deployment.json', '/assets/config.js', '/config.js', '/assets/deployment.json', '/chain/config.json', '/mint/chain/config.json', '/config.json', '/config/sensei-mint.json', '/app.js', '/assets/app.js', '/llms.txt'];
  const r1 = await Promise.all(wave1.map(async (p) => ({ p, ...(await fetchText(base + p, 2200)) })));
  let mint = null,
    token = null,
    brand = null,
    sources = [],
    meta = {};
  for (const r of r1) {
    if (!r.ok || !r.text) continue;
    const cfg = parseConfig(r.text);
    if (cfg.mint && !mint) {
      mint = cfg.mint;
      sources.push(r.p);
    }
    if (cfg.token && !token) token = cfg.token;
    if (cfg.brand && !brand) brand = cfg.brand;
    if (cfg.projectAddress) meta.projectAddress = cfg.projectAddress;
    if (cfg.priceRaw) meta.priceRaw = cfg.priceRaw;
    if (cfg.rpcs) meta.rpcs = cfg.rpcs;
    if (cfg.claimFree) meta.claimFree = cfg.claimFree;
    if (cfg.freeCap) meta.freeCap = cfg.freeCap;
    if (cfg.mintUsdtSel) meta.mintUsdtSel = cfg.mintUsdtSel;
    if (cfg.hasMintWithBnb) meta.hasMintWithBnb = true;
  }
  if (!mint) {
    // wave2: homepage + chain.js (+ HTML bscscan / NEXT_PUBLIC_CONTRACT)
    const wave2 = ['/', '/assets/chain.js', '/assets/app.js'];
    const r2 = await Promise.all(wave2.map(async (p) => ({ p, ...(await fetchText(base + p, 2200)) })));
    for (const r of r2) {
      if (!r.ok || !r.text) continue;
      const cfg = parseConfig(r.text);
      if (cfg.mint && !mint) {
        mint = cfg.mint;
        sources.push(r.p);
      }
      if (cfg.token && !token) token = cfg.token;
      if (cfg.brand && !brand) brand = cfg.brand;
      if (cfg.claimFree) meta.claimFree = cfg.claimFree;
      if (cfg.freeCap) meta.freeCap = cfg.freeCap;
      if (cfg.mintUsdtSel) meta.mintUsdtSel = cfg.mintUsdtSel;
      if (cfg.hasMintWithBnb) meta.hasMintWithBnb = true;
      if (!mint) {
        const m =
          r.text.match(/bscscan\.com\/address\/(0x[a-fA-F0-9]{40})/i) ||
          r.text.match(/NEXT_PUBLIC_CONTRACT[^0-9a-fx]{0,20}(0x[a-fA-F0-9]{40})/i) ||
          r.text.match(/CONTRACT[^0-9a-fx]{0,12}(0x[a-fA-F0-9]{40})/i);
        if (m) {
          mint = m[1];
          sources.push(r.p + '#html-addr');
        }
      }
    }
  }
  return { base, mint, token, brand, sources, meta };
}

const SEL = {
  sharesSold: '0x192fc516',
  totalShares: '0x3a98ef39',
  openAt: '0xa0e23ebd',
  opened: '0x5f88eade',
  paused: '0x5c975abb',
  quote: '0xed1bd76c',
  priceOf: '0xb9186d7d',
  mintWithBnbFly: '0x02163e1f', // mintWithBnb(uint256,bytes32,uint256)
  mintSharesAddr: '0x94bf804d', // mint(uint256,address) payable — GooseMint/sklagent
  mintWithBnbAddr: '0xe38fd349', // mintWithBnb(uint256,address,uint256)
  mintUsdt: '0x836a1040', // mint(uint256,address,uint256) USDT path
  claimFree: '0xf366afc9',
  freeMinted: '0xd10a1a2b',
  freeClaimed: '0x0668f9a5',
  walletStatus: '0x4d6d0af8',
  token: '0xfc0c546a',
  usdt: '0x2f48ab7d',
  balanceOf: '0x70a08231',
  getAmountsOut: '0xd06ca61f',
  // longxia / cats — costOf may be USDT wei, NOT native BNB
  costOf: '0xfd326592', // costOf(uint256)
  totalMinted: '0xa2309ff8',
  // bnbdog-like
  mintedShares: '0x5a3b1e4c', // may fail — also try sharesSold
};

function balOverride(from, weiHex) {
  return { [from]: { balance: weiHex } };
}

async function main() {
  if (!target) {
    console.error('usage: node check.mjs <url|0x>');
    process.exit(2);
  }
  const disc = await discover(target);
  if (disc.meta?.rpcs?.length) {
    for (const u of disc.meta.rpcs.reverse()) {
      if (typeof u === 'string' && u.startsWith('http')) RPCS.unshift(u);
    }
  }
  const mint = disc.mint;
  if (!mint) {
    console.log(JSON.stringify({ ok: false, error: 'mint not found', elapsedMs: Math.round(performance.now() - t0), disc }, null, 2));
    process.exit(1);
  }

  // One fat batch: state + quote + costOf + balances
  const calls = [
    { method: 'eth_call', params: [{ to: mint, data: SEL.sharesSold }, 'latest'] }, // 0
    { method: 'eth_call', params: [{ to: mint, data: SEL.totalShares }, 'latest'] }, // 1
    { method: 'eth_call', params: [{ to: mint, data: SEL.openAt }, 'latest'] }, // 2
    { method: 'eth_call', params: [{ to: mint, data: SEL.opened }, 'latest'] }, // 3
    { method: 'eth_call', params: [{ to: mint, data: SEL.paused }, 'latest'] }, // 4
    { method: 'eth_call', params: [{ to: mint, data: SEL.quote + encUint(1n) }, 'latest'] }, // 5
    { method: 'eth_call', params: [{ to: mint, data: SEL.quote + encUint(SHARES) }, 'latest'] }, // 6
    { method: 'eth_call', params: [{ to: mint, data: SEL.priceOf + encUint(1n) }, 'latest'] }, // 7
    { method: 'eth_call', params: [{ to: mint, data: SEL.token }, 'latest'] }, // 8
    { method: 'eth_call', params: [{ to: mint, data: SEL.costOf + encUint(SHARES) }, 'latest'] }, // 9
    { method: 'eth_call', params: [{ to: mint, data: SEL.totalMinted }, 'latest'] }, // 10
    { method: 'eth_call', params: [{ to: mint, data: SEL.freeMinted }, 'latest'] }, // 11
    { method: 'eth_call', params: [{ to: mint, data: SEL.costOf + encUint(1n) }, 'latest'] }, // 12 unit cost
    { method: 'eth_call', params: [{ to: mint, data: SEL.usdt }, 'latest'] }, // 13 usdt() if any
  ];
  const BAL0 = 14; // wallet balances start here
  for (const w of WALLETS) {
    calls.push({ method: 'eth_getBalance', params: [w, 'latest'] });
    calls.push({ method: 'eth_call', params: [{ to: USDT, data: SEL.balanceOf + encAddr(w) }, 'latest'] });
  }

  // router rate 0.001 BNB -> USDT
  const amountIn = 10n ** 15n;
  const pathData =
    SEL.getAmountsOut + encUint(amountIn) + encUint(64) + encUint(2) + encAddr(WBNB) + encAddr(USDT);
  calls.push({ method: 'eth_call', params: [{ to: ROUTER, data: pathData }, 'latest'] });

  const batch = await rpcBatch(calls);
  const res = (i) => (batch[i] && batch[i].result ? batch[i].result : null);
  const err = (i) => (batch[i] && batch[i].error ? batch[i].error : null);

  const quoteN = res(6);
  const costOf = res(9);
  const totalMinted = res(10) && !err(10) ? decUint(res(10)) : null;
  const freeMinted = res(11) && !err(11) ? decUint(res(11)) : null;
  const unitCost = res(12) && !err(12) ? decUint(res(12)) : null;
  const usdtOn = res(13) && !err(13) && res(13).length >= 66 ? '0x' + res(13).slice(-40) : null;
  const freeCap = BigInt(disc.meta?.freeCap || 2000);
  const hasClaimFree = !!disc.meta?.claimFree || freeMinted !== null;
  const inFreePhase = hasClaimFree && (freeMinted !== null ? freeMinted < freeCap : totalMinted !== null && totalMinted < freeCap);
  // costOf often returns USDT wei (18dec). Only treat as native BNB when mintWithBnb path is explicit AND no USDT mint/claimFree.
  const looksUsdtPay = !!(disc.meta?.mintUsdtSel || usdtOn || (hasClaimFree && !disc.meta?.hasMintWithBnb));
  const flyMode = quoteN && !err(6);
  const costMode = costOf && !err(9) && decUint(costOf) > 0n;

  let mode = 'native';
  let unitLabel = '';
  let perWallet = '';
  let fourTotal = '';
  let valueWei = 0n;
  let mintData = '0x';
  let progress = null;
  let tokenOn = disc.token;
  let paid = true;
  let free = false;
  let simKind = 'native';
  let payToken = 'BNB';

  if (inFreePhase) {
    // Fast path: free claim — never wait on costOf/BNB misread
    mode = 'claimFree';
    payToken = 'FREE';
    valueWei = 0n;
    mintData = SEL.claimFree;
    simKind = 'claimFree';
    paid = false;
    free = true;
    const sold = freeMinted ?? totalMinted ?? 0n;
    progress = `${sold} / ${freeCap} free`;
    unitLabel = '0 (claimFree)';
    perWallet = '0';
    fourTotal = '0';
  } else if (flyMode) {
    mode = 'fly';
    const unitRaw = decUint(res(7) || res(5) || '0x0');
    const costRaw = decUint(quoteN);
    // Sensei/BNB launchpads: quote is wei BNB (~1e15–1e17). USDT quotes are usually >=1e18 per share or 6dec.
    let baseWei = 0n;
    try { if (disc.meta?.priceRaw) baseWei = BigInt(String(disc.meta.priceRaw).replace(/n$/, '')); } catch {}
    const looksBnb = (baseWei > 0n && baseWei < 10n ** 17n) || (unitRaw > 0n && unitRaw < 10n ** 17n && costRaw < 10n ** 18n) || (costRaw > 0n && costRaw < 10n ** 18n && unitRaw === 0n);
    // GooseMint-style: quote(uint256)->BNB wei + mint(uint256,address) payable. Do NOT pancake-convert.
    const gooseMint = looksBnb && !disc.meta?.hasMintWithBnb;
    payToken = looksBnb ? 'BNB' : 'USDT';
    const unitUsdt = unitRaw > 0n ? unitRaw : (SHARES > 0n ? costRaw / SHARES : 0n);
    const costUsdt = costRaw;
    progress =
      totalMinted != null
        ? String(totalMinted)
        : `${decUint(res(0) || '0x0')} / ${decUint(res(1) || '0x0')}`;
    const tok = res(8);
    if (tok && tok.length >= 66) tokenOn = '0x' + tok.slice(-40);
    paid = costUsdt > 0n;
    free = costUsdt === 0n;
    unitLabel = `${fmt(unitUsdt)} ${payToken}`;
    perWallet = `${fmt(costUsdt)} ${payToken}`;
    fourTotal = `${fmt(costUsdt * 4n)} ${payToken}`;
    if (gooseMint) {
      valueWei = costUsdt; // exact quote, no +2% / no USDT→BNB rewrite
      mintData =
        SEL.mintSharesAddr +
        encUint(SHARES) +
        encAddr('0x0000000000000000000000000000000000000000');
      simKind = 'mint(uint256,address)/quote';
      mode = 'goose';
    } else if (looksBnb) {
      valueWei = (costUsdt * 102n) / 100n;
      const minOut = (costUsdt * 98n) / 100n;
      mintData = SEL.mintWithBnbFly + encUint(SHARES) + encBytes32('0x' + '0'.repeat(64)) + encUint(minOut);
      simKind = 'mintWithBnb';
    } else {
      let rate = 0n;
      const ao = res(calls.length - 1);
      if (ao && ao.length > 2) {
        try {
          const body = ao.slice(2);
          rate = BigInt('0x' + body.slice(64 * 3, 64 * 4));
        } catch {}
      }
      if (rate > 0n) valueWei = (costUsdt * amountIn * 102n) / (rate * 100n);
      else valueWei = (costUsdt * 10n ** 18n * 102n) / (700n * 100n);
      const minOut = (costUsdt * 98n) / 100n;
      mintData = SEL.mintWithBnbFly + encUint(SHARES) + encBytes32('0x' + '0'.repeat(64)) + encUint(minOut);
      simKind = 'mintWithBnb';
    }
  } else if (costMode && looksUsdtPay) {
    // USDT mint(uint256,address,uint256) — costOf is USDT wei
    mode = 'usdt';
    payToken = 'USDT';
    const cost = decUint(costOf);
    const unit = unitCost != null ? unitCost : cost / (SHARES || 1n);
    const maxPay = (cost * 102n) / 100n;
    valueWei = 0n;
    progress =
      totalMinted != null
        ? String(totalMinted)
        : res(0) && !err(0)
          ? `${decUint(res(0))} / ${decUint(res(1) || '0x0')}`
          : null;
    paid = cost > 0n;
    free = cost === 0n;
    unitLabel = `${fmt(unit)} USDT`;
    perWallet = `${fmt(cost)} USDT`;
    fourTotal = `${fmt(cost * 4n)} USDT`;
    mintData =
      SEL.mintUsdt +
      encUint(SHARES) +
      encAddr('0x0000000000000000000000000000000000000000') +
      encUint(maxPay);
    simKind = 'mint(USDT)/costOf';
  } else if (costMode) {
    mode = 'costOf';
    payToken = 'BNB';
    const cost = decUint(costOf);
    const maxCost = (cost * 102n) / 100n;
    valueWei = maxCost;
    progress = totalMinted != null ? String(totalMinted) : null;
    paid = cost > 0n;
    free = cost === 0n;
    unitLabel = `${fmt(cost / SHARES)} BNB`;
    perWallet = `${fmt(cost)} BNB`;
    fourTotal = `${fmt(cost * 4n)} BNB`;
    mintData = SEL.mintWithBnbAddr + encUint(SHARES) + encAddr('0x0000000000000000000000000000000000000000') + encUint(maxCost);
    simKind = 'mintWithBnb(address)/costOf';
  } else {
    // native BNB transfer — try PRICE from config or 0.03
    let price = 3n * 10n ** 15n; // 0.003 default per share
    if (disc.meta?.priceRaw) {
      try {
        price = BigInt(String(disc.meta.priceRaw).replace(/n$/, ''));
      } catch {}
    }
    valueWei = price * SHARES;
    if (res(0) && !err(0)) progress = `${decUint(res(0))} / ${decUint(res(1) || '0x0')}`;
    unitLabel = `${fmt(price)} BNB`;
    perWallet = `${fmt(valueWei)} BNB`;
    fourTotal = `${fmt(valueWei * 4n)} BNB`;
    mintData = '0x';
    simKind = 'native-transfer';
    paid = valueWei > 0n;
    free = valueWei === 0n;
    payToken = 'BNB';
  }

  // Parallel sims — one batch with state overrides (may fail on some nodes → per-wallet fallback)
  const simCalls = WALLETS.map((w) => {
    const need = valueWei + 10n ** 17n;
    const tx = {
      to: mint,
      from: w,
      data: mintData,
      value: '0x' + valueWei.toString(16),
    };
    return {
      method: 'eth_call',
      params: [tx, 'latest', balOverride(w, '0x' + need.toString(16))],
    };
  });

  let simBatch;
  try {
    simBatch = await rpcBatch(simCalls, 8000);
  } catch {
    simBatch = WALLETS.map(() => ({ error: 'batch fail' }));
  }

  // If overrides unsupported, retry without override in one batch (will show FAIL if low bal — still report)
  const needRetry = simBatch.every((s) => s.error && /override|state|params|invalid/i.test(String(s.error)));
  if (needRetry) {
    try {
      simBatch = await rpcBatch(
        WALLETS.map((w) => ({
          method: 'eth_call',
          params: [{ to: mint, from: w, data: mintData, value: '0x' + valueWei.toString(16) }, 'latest'],
        })),
        8000,
      );
    } catch {}
  }

  const sims = WALLETS.map((w, i) => {
    const bnb = decUint(res(BAL0 + i * 2) || '0x0');
    const usdt = decUint(res(BAL0 + i * 2 + 1) || '0x0');
    const s = simBatch[i] || {};
    const ok = !s.error && s.result !== undefined;
    return {
      wallet: w,
      bnb: fmt(bnb),
      usdt: fmt(usdt),
      shortfallBnb: valueWei > bnb ? fmt(valueWei - bnb) : '0',
      sim: ok ? 'OK' : 'FAIL',
      err: s.error ? String(s.error).slice(0, 120) : null,
    };
  });

  const out = {
    ok: true,
    brand: disc.brand,
    url: target,
    mint,
    token: tokenOn,
    mode,
    simKind,
    shares: Number(SHARES),
    progress,
    openAt: res(2) && !err(2) ? Number(decUint(res(2))) : null,
    opened: res(3) && !err(3) ? Number(decUint(res(3))) : null,
    paused: res(4) && !err(4) ? Number(decUint(res(4))) : null,
    unit: unitLabel,
    perWallet,
    fourWalletTotal: fourTotal,
    valueBnb: fmt(valueWei),
    payToken,
    paid,
    free,
    mintData,
    claimFree: inFreePhase,
    freeMinted: freeMinted != null ? Number(freeMinted) : null,
    freeCap: Number(freeCap),
    sims,
    simOk: sims.filter((x) => x.sim === 'OK').length,
    sources: disc.sources,
    rpc: rpcUrl,
    elapsedMs: Math.round(performance.now() - t0),
  };
  writeFileSync('/tmp/mint-fast-last.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e.stack || e), elapsedMs: Math.round(performance.now() - t0) }, null, 2));
  process.exit(1);
});
