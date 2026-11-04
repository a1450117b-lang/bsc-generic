#!/usr/bin/env node
/**
 * BSC mint PRE-CHECK (READ-ONLY). Never signs / approves / pays / broadcasts.
 * node precheck.mjs <url-or-CA> [--json] [--shares N] [--no-history-write] [--name X] [--no-tax] [--quiet]
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { ROOT, WALLETS, USDT, WBNB, AGENT_ID_REGISTRY, ZERO, KNOWN, isAddr, lc, short, fmtUnits, timer, ethers, encAddr, encUint, decAddr, bigJson, fetchText, withTimeout, sel } from './lib/util.mjs';
import { batch, stats as rpcStats, recentLogs } from './lib/rpc.mjs';
import { discover } from './lib/discovery.mjs';
import { fingerprint } from './lib/fingerprint.mjs';
import * as sigdb from './lib/sigdb.mjs';
import * as H from './lib/history.mjs';
import { decodeGuess, decodeRevert, findSlots, erc20Override, simulate, estimateGas } from './lib/evm.mjs';
import { scoreMintCandidates, TEMPLATES, buildArgs, encode, templFromTx, fillTx } from './lib/mintfn.mjs';
import { staticRisks, simRisks, tokenTax } from './lib/risk.mjs';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.findIndex((a) => a === f || a.startsWith(f + '=')); if (i < 0) return d; return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1]; };
const optVals = new Set(['--shares', '--name'].flatMap((f) => { const i = argv.indexOf(f); return i >= 0 ? [argv[i + 1]] : []; }));
const target = argv.find((a) => !a.startsWith('--') && !optVals.has(a));
if (!target) { console.error('usage: node precheck.mjs <url-or-CA> [--json] [--shares N] [--no-history-write]'); process.exit(2); }
const JSON_OUT = flag('--json');
const T = timer();
const startedAt = new Date();
const localTs = startedAt.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[ :]/g, '').replace(/-/g, '') + '+08';
const out = { tool: 'bsc-mint-precheck', version: 1, readOnly: true, input: target, startedAt: startedAt.toISOString(), startedAtLocal: startedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)', chainId: 56 };
const anomalies = [];
let poolOpenFlag = false;
const sigOf = (s, map) => map[s]?.sig || sigdb.name1(s) || s;

async function sourcify(addr) {
  const cf = `${ROOT}/cache/sourcify-${lc(addr)}.json`;
  try { const c = JSON.parse(readFileSync(cf, 'utf8')); if (c.verified || Date.now() - c.at < 6 * 3600e3) return { ...c, cached: true }; } catch {}
  const r = await fetchText(`https://sourcify.dev/server/v2/contract/56/${addr}?fields=abi,deployment,compilation.name`, 3500);
  if (!r.ok) { const o = { verified: r.status === 404 ? false : null, at: Date.now() }; if (r.status === 404) writeFileSync(cf, JSON.stringify(o)); return o; }
  try { const j = JSON.parse(r.text); const o = { verified: !!j.match, match: j.match, abi: j.abi || null, name: j.compilation?.name, deployment: j.deployment, at: Date.now() }; writeFileSync(cf, JSON.stringify(o)); return o; } catch { return { verified: null }; }
}
function sigmapFrom(fp, abi) {
  const m = {};
  for (const s of fp.selectors || []) { const n = sigdb.name1(s); m[s] = { sig: n || null, name: n ? n.split('(')[0] : null }; }
  if (abi) {
    const iface = new ethers.Interface(abi.filter((x) => x.type === 'function' || x.type === 'error'));
    iface.forEachFunction((f) => { m[f.selector] = { sig: f.format('sighash'), name: f.name, inputs: f.inputs.map((i) => ({ name: i.name, type: i.type })), outputs: f.outputs.map((o) => o.type), stateMutability: f.stateMutability }; });
    sigdb.addSigs(abi.filter((x) => x.type === 'error').map((e) => `${e.name}(${(e.inputs || []).map((i) => ethers.ParamType.from(i).format('sighash')).join(',')})`));
  }
  return m;
}
const isERC20 = (m) => ['balanceOf', 'transfer', 'totalSupply', 'decimals', 'allowance'].every((n) => Object.values(m).some((x) => x.name === n));
const isPair = (m) => ['token0', 'token1', 'getReserves'].every((n) => Object.values(m).some((x) => x.name === n));
const SKIP_READ = /^(set|seal|deploy|withdraw|renounce|transfer|approve|upgrade|sweep|skim|sync|rescue|emergency|init|initialize|pause|unpause|launch|buyback|feed|fundReserve|collect|sealImports|swapTax|openPoolStall|accept)/i;

async function main() {
  const shares0 = BigInt(opt('--shares', '10'));
  // ---------- history preload (fast path for known hosts) ----------
  const COLD = flag('--cold');
  const allHist = COLD ? [] : H.loadAll();
  let host = null;
  if (!isAddr(target)) { try { host = new URL(target.includes('://') ? target : 'https://' + target).host; } catch {} }
  const hostRec = host ? allHist.find((r) => r.url && r.url.includes(host) && r.discovery?.sourcePaths?.length) : null;
  // ---------- discovery ----------
  const preFp = hostRec ? fingerprint(hostRec.mintContract).catch(() => null) : isAddr(target) ? fingerprint(target).catch(() => null) : null; // overlap with discovery
  const disc = await discover(target, { fastPaths: hostRec?.discovery?.sourcePaths, fastOnly: !!hostRec });
  T.mark('discovery');
  out.discovery = { base: disc.base, title: disc.title, fetchedOk: disc.fetched.filter((f) => f.status === 200).map((f) => f.path), top: disc.candidates.slice(0, 8).map((c) => ({ addr: c.addr, score: c.score, keys: c.keys.slice(0, 3), known: c.known })), fastPath: !!hostRec };
  let cands = disc.candidates.filter((c) => !c.known).slice(0, isAddr(target) ? 1 : 6);
  if (hostRec && cands.some((c) => lc(c.addr) === lc(hostRec.mintContract))) cands = cands.filter((c) => lc(c.addr) === lc(hostRec.mintContract)); // history fast path (still re-verified by bytecode)
  if (isAddr(target) && KNOWN[lc(target)]) cands = [{ addr: target, score: 0, keys: ['cli'], known: KNOWN[lc(target)] }];
  const hostAny = host ? allHist.find((r) => r.url && r.url.includes(host)) : null;
  if (!cands.length && hostAny) {
    const st = [...new Set(disc.fetched.filter((f) => f.path === '/' || f.path === (new URL(disc.input.includes('://') ? disc.input : 'https://' + disc.input).pathname)).map((f) => f.status))].join('/');
    anomalies.push(`站点未暴露合约地址(首页 HTTP ${st}) → 使用历史库地址 ${hostAny.mintContract}（已链上重新核对字节码/价格）`);
    cands = [{ addr: hostAny.mintContract, score: 40, keys: ['history-host'], srcs: ['history'] }];
  }
  if (!cands.length) { out.status = 'no-candidate'; out.needs_ai_analysis = true; out.reason = '站点未发现任何合约地址'; return finish(); }
  // ---------- fingerprint ----------
  const pre = preFp ? await preFp : null;
  const fps = await Promise.all(cands.map((c) => (pre && lc(pre.address) === lc(c.addr) ? Promise.resolve(pre) : fingerprint(c.addr)).catch((e) => ({ address: c.addr, error: String(e.message || e) }))));
  T.mark('fingerprint');
  // ---------- history match (local, instant) ----------
  const matches = fps.map((fp) => (fp.isContract && !COLD ? H.match(fp, { host }) : []));
  for (const ms of matches) for (const m of ms) if (m.record.sigNames) sigdb.addSigs(Object.values(m.record.sigNames));
  T.mark('historyMatch');
  // ---------- resolve names + sourcify (parallel) ----------
  const allSel = [...new Set(fps.flatMap((f) => [...(f.selectors || []), ...(f.pushed4 || [])]))];
  const contractFps = fps.filter((f) => f.isContract);
  const dbg = (m) => process.env.DEBUG && console.error('[dbg]', m, T.total());
  const [, srcs] = await Promise.all([
    sigdb.resolve(allSel).then((r) => (dbg('resolve ' + JSON.stringify(r)), r)),
    Promise.all(contractFps.slice(0, 4).map((f) => withTimeout(sourcify(f.impl || f.address), 4000, { verified: null }).then((r) => (dbg('sourcify ' + f.address + ' ' + !!r.cached), r)))), // cached on disk
  ]);
  T.mark('signatures');
  // ---------- choose mint contract ----------
  const analysed = contractFps.map((fp, i) => {
    const src = srcs[i] || { verified: null };
    const sm = sigmapFrom(fp, src.abi);
    const ms = matches[fps.indexOf(fp)] || [];
    const mintCands = scoreMintCandidates(sm, { siteNames: disc.abiNames, historySel: ms[0]?.score >= 0.6 ? ms[0].record.mintSelector : null });
    const c = cands.find((x) => lc(x.addr) === lc(fp.address));
    let score = (c?.score || 0) + (mintCands[0]?.score || 0);
    const pair = isPair(sm), erc20 = isERC20(sm);
    if (pair) score -= 150;
    if (erc20 && (!mintCands.length || mintCands[0].score < 40)) score -= 60;
    if (ms[0]) score += 30 * ms[0].score;
    return { fp, src, sm, mintCands, score, pair, erc20, match: ms };
  }).sort((a, b) => b.score - a.score);
  out.candidatesClassified = analysed.map((a) => ({ addr: a.fp.address, score: Math.round(a.score), role: a.pair ? 'pair' : a.erc20 ? (a.mintCands.length ? 'token(+mint fn)' : 'token') : a.mintCands.length ? 'mint?' : 'contract', topMint: a.mintCands[0]?.sig || null }));
  const eoas = fps.filter((f) => !f.isContract && !f.error).map((f) => f.address);
  if (!analysed.length) { out.status = 'not-contract'; out.verdict = `非合约地址（EOA/无代码）: ${eoas.join(',')}`; return finish(); }
  const A = analysed[0];
  const fp = A.fp, sm = A.sm, mint = fp.address;
  out.mintContract = mint;
  out.fingerprint = { codeHash: fp.codeHash, normHash: fp.normHash, codeSize: fp.codeSize, proxyType: fp.proxyType, impl: fp.impl, admin: fp.admin, implCodeHash: fp.implCodeHash, selectorCount: fp.selectors.length, verified: A.src.verified, sourceName: A.src.name || null };
  const best = A.match[0] || null;
  out.historyMatch = best ? { id: best.id, name: best.name, kind: best.kind, similarity: best.score, outcome: best.record.outcome, lessons: best.record.lessons } : null;
  const rec = best && best.score >= 0.6 ? best.record : null;
  // ---------- reads (parallel) ----------
  const fnBy = (re) => Object.entries(sm).filter(([, v]) => v.name && re.test(v.name));
  const zeroArg = Object.entries(sm).filter(([s, v]) => v.sig && v.sig.endsWith('()') && !SKIP_READ.test(v.name) && !A.mintCands.some((m) => m.selector === s)).slice(0, 140);
  const nArg = Object.entries(sm).filter(([, v]) => v.sig && /^(quote|cost|price|getPrice|getMintPrice|bnbQuote|unitPrice|quoteMint|quoteTokens|quoteGen|priceOf|costOf|calc)/i.test(v.name) && /\((uint256)\)$/.test(v.sig));
  const perW = Object.entries(sm).filter(([, v]) => v.sig && /\((address)\)$/.test(v.sig) && /^(minted|mintedBy|numberMinted|mintedOf|mintCount|quota|quotaOf|extraQuota|remaining|walletStatus|paidOnce|freeClaimed|claimed|hasMinted|canMint|mintedCount|inviteCount|referrer|inviter|agentOf|agentKeyOf|bound|accountAgent|pensLeftOf|pensUsedOf|pendingGen0|pendingGen1|whitelist|isWhitelisted|isBlacklisted|blacklist|balanceOf)/i.test(v.name)).slice(0, 14);
  const calls = [];
  const idx = {};
  const push = (k, c) => { idx[k] = calls.length; calls.push(c); };
  for (const [s] of zeroArg) push('z:' + s, { method: 'eth_call', params: [{ to: mint, data: s }, 'latest'] });
  for (const [s] of nArg) { push('n1:' + s, { method: 'eth_call', params: [{ to: mint, data: s + encUint(1) }, 'latest'] }); push('nN:' + s, { method: 'eth_call', params: [{ to: mint, data: s + encUint(shares0) }, 'latest'] }); }
  for (const [s] of perW) WALLETS.forEach((w) => push(`w:${s}:${w.id}`, { method: 'eth_call', params: [{ to: mint, data: s + encAddr(w.addr) }, 'latest'] }));
  WALLETS.forEach((w) => {
    push('bnb:' + w.id, { method: 'eth_getBalance', params: [w.addr, 'latest'] });
    push('usdt:' + w.id, { method: 'eth_call', params: [{ to: USDT, data: '0x70a08231' + encAddr(w.addr) }, 'latest'] });
    push('agent:' + w.id, { method: 'eth_call', params: [{ to: AGENT_ID_REGISTRY, data: '0x70a08231' + encAddr(w.addr) }, 'latest'] });
  });
  push('block', { method: 'eth_getBlockByNumber', params: ['latest', false] });
  push('gasPrice', { method: 'eth_gasPrice', params: [] });
  const tpl0 = TEMPLATES[A.mintCands[0]?.selector];
  const needRecent = !rec || !tpl0 || !!tpl0.needsProject || flag('--recent');
  const tokenGuess = rec?.token || disc.candidates.find((c) => c.keys.some((k) => /(^|\.)token$/i.test(k)))?.addr || null;
  const taxEarly = flag('--no-tax') || !tokenGuess ? null : withTimeout(tokenTax(tokenGuess).catch((e) => ({ status: 'err ' + e.message })), 8000, { status: 'timeout' });
  const [res, recent] = await Promise.all([
    batch(calls),
    !needRecent ? Promise.resolve({ count: 0, skipped: 'history-match' }) : withTimeout((async () => {
      const bn = await batch([{ method: 'eth_blockNumber', params: [] }]);
      const latest = Number(BigInt(bn[0].result));
      let lg = await withTimeout(recentLogs({ address: mint }, latest, 1000), 3000, { logs: [], errors: ['timeout'] });
      if (!lg.logs.length) lg = await withTimeout(recentLogs({ address: mint }, latest, 5000), 2500, { logs: [], errors: ['timeout'] });
      const hashes = [...new Set(lg.logs.map((l) => l.transactionHash))].slice(-8);
      if (!hashes.length) return { count: 0, logsRange: lg.range, errors: lg.errors };
      const txs = await batch(hashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
      const list = txs.map((t) => t.result).filter((t) => t && lc(t.to) === lc(mint) && t.input?.length >= 10);
      const counts = {};
      for (const t of list) counts[t.input.slice(0, 10)] = (counts[t.input.slice(0, 10)] || 0) + 1;
      return { count: list.length, logsRange: lg.range, counts, txs: list.map((t) => ({ hash: t.hash, from: t.from, value: t.value, selector: t.input.slice(0, 10), input: t.input, inputLen: (t.input.length - 2) / 2 })) };
    })().catch((e) => ({ count: 0, errors: [String(e.message || e)] })), Number(process.env.RECENT_TIMEOUT_MS || 4500), { count: 0, errors: ['recent-tx timeout'] }),
  ]);
  T.mark('reads');
  const R = (k) => res[idx[k]];
  const reads = {}, readsRaw = {};
  for (const [s, v] of zeroArg) { const r = R('z:' + s); if (r?.result && r.result !== '0x') { const d = decodeGuess(r.result, v.outputs); reads[v.name] = d.v; readsRaw[v.name] = d; } }
  const nReads = {};
  for (const [s, v] of nArg) { const a = R('n1:' + s), b = R('nN:' + s); const first = (x) => (Array.isArray(x) ? (typeof x[0] === 'bigint' ? x[0] : null) : x); nReads[v.name] = { sel: s, one: a?.result ? first(decodeGuess(a.result, v.outputs).v) : null, n: b?.result ? first(decodeGuess(b.result, v.outputs).v) : null, errN: b?.error ? decodeRevert(b.error) : null }; }
  const perWallet = {};
  for (const [s, v] of perW) perWallet[v.name] = WALLETS.map((w) => { const r = R(`w:${s}:${w.id}`); return r?.result ? decodeGuess(r.result, v.outputs).v : r?.error ? 'ERR' : null; });
  const block = R('block')?.result; const nowTs = block ? Number(BigInt(block.timestamp)) : Math.floor(Date.now() / 1000);
  const gasPrice = R('gasPrice')?.result ? BigInt(R('gasPrice').result) : 10n ** 8n;
  // ---------- choose mint fn ----------
  for (const [s0, v] of Object.entries(sm)) if (fp.payable?.[s0] !== undefined && v.stateMutability === undefined && fp.payable[s0] !== null) v.payableHint = fp.payable[s0];
  const mintCands = scoreMintCandidates(sm, { recent: recent.counts || {}, siteNames: disc.abiNames, historySel: rec?.mintSelector });
  // price plausibility per candidate (suffix-paired quote getter): >1 BNB/unit for a BNB-looking mint → probably priced in another token
  for (const m of mintCands) {
    const suf = m.name.replace(/^(mint|buy|purchase|claim)(With)?/i, '').toLowerCase();
    const q = suf && Object.entries(nReads).find(([k]) => k.toLowerCase().endsWith(suf) && /quote|cost|price/i.test(k));
    if (q && typeof q[1].one === 'bigint' && q[1].one > 10n ** 18n && !/usdt/i.test(m.name)) { m.score -= 15; m.note = 'paired price >1/unit (非BNB计价?)'; }
    if (sm[m.selector]?.payableHint === true || sm[m.selector]?.stateMutability === 'payable') m.score += 3;
  }
  mintCands.sort((a, b) => b.score - a.score);
  const mf = mintCands[0] || null;
  out.mintCandidates = mintCands.slice(0, 5).map((m) => ({ sig: m.sig, selector: m.selector, score: m.score, template: m.template }));
  out.recentTx = { skipped: recent.skipped, count: recent.count, counts: recent.counts, range: recent.logsRange, sample: recent.txs?.slice(-2).map((t) => ({ hash: t.hash, from: t.from, selector: t.selector, value: fmtUnits(BigInt(t.value)), inputLen: t.inputLen })) };
  // token / roles
  const tokenAddr = [reads.token, reads.nft, reads.TOKEN, reads.rewardToken].find((x) => isAddr(x)) || disc.candidates.find((c) => c.keys.some((k) => /(^|\.)token$/i.test(k)))?.addr || null;
  out.token = tokenAddr;
  // agent-id gating
  const regRef = fp.addrs.some((a) => lc(a) === lc(AGENT_ID_REGISTRY)) || Object.values(reads).some((v) => typeof v === 'string' && lc(v) === lc(AGENT_ID_REGISTRY));
  let agentGate = regRef;
  if (!agentGate) {
    const gateAddrs = Object.entries(reads).filter(([k, v]) => isAddr(v) && /eligib|agent|registry|idCollection/i.test(k)).map(([, v]) => v);
    if (gateAddrs.length) {
      const codes = await batch(gateAddrs.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
      agentGate = codes.some((c) => (c.result || '').toLowerCase().includes(lc(AGENT_ID_REGISTRY).slice(2)));
    }
  }
  const agentBal = WALLETS.map((w) => { const r = R('agent:' + w.id); return r?.result ? BigInt(r.result.slice(0, 66)) : null; });
  // ---------- price / pay token ----------
  const tpl = mf ? TEMPLATES[mf.selector] : null;
  const suffix = mf ? mf.name.replace(/^(mint|buy|purchase|claim)(With)?/i, '') : '';
  let priceSrc = null, unit = null, costN = null;
  const nEntries = Object.entries(nReads).filter(([k, v]) => (typeof v.one === 'bigint' || typeof v.n === 'bigint') && !/(tokens|allocation|out$|amountOut|reward|units$|bps)/i.test(k) && (typeof v.one === 'bigint' ? v.one > 0n : v.n > 0n));
  const pref = ['quote', 'costOf', 'quoteCost', 'bnbQuote', 'getMintPrice', 'getPrice', 'priceOf', 'cost', 'quoteMint', 'unitPrice'];
  const pickN = (suffix && nEntries.find(([k]) => k.toLowerCase().endsWith(suffix.toLowerCase()) && /quote|cost|price/i.test(k) && !/^(quote|cost)$/i.test(k)))
    || pref.map((p) => nEntries.find(([k]) => k.toLowerCase() === p.toLowerCase())).find(Boolean)
    || nEntries.find(([k]) => /^(quote|cost|price)/i.test(k) && !/unitPrice/i.test(k));
  if (process.env.DEBUG) console.error("[dbg] nEntries", nEntries.map(([k, v]) => k + ":" + typeof v.one + ":" + v.one), "pick", pickN && pickN[0]);
  if (pickN) { priceSrc = `${pickN[0]}(n)`; unit = typeof pickN[1].one === 'bigint' ? pickN[1].one : null; costN = typeof pickN[1].n === 'bigint' ? pickN[1].n : unit !== null ? unit * shares0 : null; if (/(priceOf|priceFor|unitPrice|priceAt|ForShare)/i.test(pickN[0]) && unit !== null) { costN = unit * shares0; priceSrc += '×N'; } const reverted = Object.entries(nReads).filter(([, v]) => v.errN).map(([k, v]) => k + '→' + v.errN); if (reverted.length) priceSrc += '｜revert: ' + reverted.slice(0, 2).join(','); }
  if (unit === null) {
    const z = Object.entries(reads).filter(([k, v]) => typeof v === 'bigint' && /(price|fee|cost)/i.test(k) && !/(bps|den|num|tol|oracle|opening|usdPrice|_usd|poke|total|fees|reserve|tax|lp|cumulative|klast)/i.test(k));
    const zp = z.find(([k]) => /(mint|base|unit|ticket|public|sale)/i.test(k)) || z[0];
    if (zp) { priceSrc = zp[0] + '()'; unit = zp[1]; costN = unit * shares0; }
  }
  // pay token
  let payToken = 'BNB', payTokenAddr = null, payWhy = 'default';
  const usdtGetter = Object.entries(reads).find(([k, v]) => /^(usdt|USDT|paymentToken|payToken|currency|quoteToken)$/.test(k) && isAddr(v));
  if (tpl) { payToken = tpl.pay; payWhy = 'template'; }
  else if (/bnb|eth|native/i.test(mf?.name || '')) { payToken = 'BNB'; payWhy = 'fn-name'; }
  else if (/usdt/i.test(mf?.name || '') || /usdt/i.test(priceSrc || '')) { payToken = 'USDT'; payWhy = 'name'; }
  else if (/bnb|wei/i.test(priceSrc || '')) { payToken = 'BNB'; payWhy = 'getter-name'; }
  else if (usdtGetter && mf?.stateMutability !== 'payable') { payToken = KNOWN[lc(usdtGetter[1])] || usdtGetter[1]; payTokenAddr = usdtGetter[1]; payWhy = 'getter ' + usdtGetter[0]; }
  const nonPayable = sm[mf?.selector]?.stateMutability ? sm[mf.selector].stateMutability !== 'payable' : sm[mf?.selector]?.payableHint === false;
  if (nonPayable && payToken === 'BNB') { if (usdtGetter) { payToken = KNOWN[lc(usdtGetter[1])] || usdtGetter[1]; payTokenAddr = usdtGetter[1]; } else if (/usdt/i.test(JSON.stringify(disc.priceHints.slice(0, 3)))) { payToken = 'USDT'; } else { payToken = 'ERC20?'; } payWhy = 'nonpayable'; }
  if (payToken === 'BNB' && unit !== null && unit > 10n ** 18n) { anomalies.push(`单价 ${fmtUnits(unit)} 若按 BNB 计价过高 → 可能以代币计价(${short(tokenAddr)})，请核对`); }
  if (sm[mf?.selector]?.stateMutability === 'payable' && payToken !== 'BNB' && payToken !== 'FREE') { anomalies.push('mint 函数 payable 但推断支付币为 ' + payToken); }
  if (payToken === 'USDT') payTokenAddr = USDT;
  if (unit === 0n && payToken !== 'FREE') payToken = 'FREE?';
  // site price hint fallback
  let priceHint = null;
  const hints = disc.priceHints.filter((h) => h.amount && /ticket|share|each|per|cost|mint|for|份|张/i.test(h.ctx || ''));
  if (hints.length) { const cnt = {}; for (const h of hints) { const k = h.amount + ' ' + h.token; cnt[k] = (cnt[k] || 0) + 1; } priceHint = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0]; }
  if (unit === null && priceHint) { const [amt, tk] = priceHint.split(' '); unit = ethers.parseUnits(amt, 18); costN = unit * shares0; priceSrc = 'site-text'; if (!tpl) payToken = tk; if (tk === 'USDT') payTokenAddr = USDT; }
  if (unit === null && rec?.price?.unitWei) { unit = BigInt(rec.price.unitWei); costN = unit * shares0; priceSrc = 'history(未实时核对!)'; anomalies.push('单价来自历史库，链上未读到，需人工核对'); }
  // shares clamp
  const maxTx = Object.entries(reads).find(([k, v]) => typeof v === 'bigint' && /^(MAX_UNITS_PER_TX|MAX_PER_TX|maxPerTx|maxMintPerTx|MAX_TICKETS|MAX_PER_CALL|maxPerTransaction)$/i.test(k));
  let shares = shares0;
  if (maxTx && maxTx[1] > 0n && shares > maxTx[1]) { shares = maxTx[1]; if (costN !== null && unit !== null) costN = unit * shares; }
  // value
  const buffer = BigInt(tpl?.buffer || 100);
  const isFree = payToken === 'FREE' || (unit === 0n);
  const valueWei = payToken === 'BNB' && costN !== null ? (costN * buffer) / 100n : 0n;
  const payAmount = payToken !== 'BNB' && !isFree && costN !== null ? costN : 0n;
  const maxPay = payToken === 'BNB' ? valueWei : (payAmount * buffer) / 100n;
  // progress
  const supKeys = Object.entries(reads).filter(([k, v]) => typeof v === 'bigint' && /(supply|minted|sold|claims|remaining|^cap$|opening_?ticket|open_?at|units|gen_?total|nexttokenid|nextid|max_supply)/i.test(k) && !/(bps|price|raw$|decimals)/i.test(k));
  const soldK = supKeys.find(([k]) => /^(totalMinted|successfulClaims|sharesSold|totalSold|soldCount|minted|unitsSold)$/i.test(k)) || supKeys.find(([k]) => suffix && k.toLowerCase().startsWith(suffix.toLowerCase()) && /sold|minted/i.test(k)) || supKeys.find(([k]) => /sold|minted|claims/i.test(k));
  const capPref = ['MAX_SUPPLY_UNITS', 'MAX_UNITS', 'maxUnits', 'totalShares', 'OPEN_UNITS', 'OPEN_AT', 'openAt', 'openThreshold', 'OPENING_TICKET', 'GEN_TOTAL', 'maxSupply', 'MAX_SUPPLY', 'cap'];
  const capK = capPref.map((p) => supKeys.find(([k]) => k === p && k !== soldK?.[0] && !(soldK && /SUPPLY/i.test(k) && supKeys.find(([kk]) => kk === k)[1] > 10n ** 24n))).find(Boolean) || supKeys.find(([k, v]) => /max|cap|total/i.test(k) && k !== soldK?.[0] && !/minted|sold|supply/i.test(k));
  // status
  const st = [];
  for (const [k, v] of Object.entries(reads)) {
    if (!/^(paused|opened|open|isOpen|saleActive|mintOpen|mintActive|publicSaleActive|started|ended|launched|poolOpened|deploymentSealed|renounced|state|phase|stage|status|tradingEnabled|marketOpen|mintEnabled|isActive|saleOpen)$/i.test(k) && !/(start|end|launch|open|deadline)(Time|At|_AT|edAt|Block)$/i.test(k)) continue;
    let s = `${k}=${typeof v === 'bigint' && v > 1_600_000_000n && v < 2_200_000_000n ? new Date(Number(v) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)' : String(v)}`;
    st.push(s);
  }
  const apiStatus = Object.entries(disc.jsons).filter(([p]) => /status|state/i.test(p)).map(([p, j]) => Object.entries(j).filter(([k, v]) => /^(open|opened|paused|phase|status|live|sealed|mainnetTest|statusStale|successfulClaims|openingTicket)$/i.test(k) && typeof v !== 'object').map(([k, v]) => `api.${k}=${v}`).join(' ')).filter(Boolean);
  const paused = reads.paused === true || reads.paused === 1n;
  const truthy = (v) => v === true || v === 1n || v === 'true';
  const apiJ = Object.entries(disc.jsons).filter(([p]) => /status|state/i.test(p)).map(([, j]) => j)[0] || {};
  const poolOpen = ['opened', 'poolOpened', 'launched', 'marketOpen', 'tradingEnabled'].some((k) => truthy(reads[k])) || truthy(apiJ.open);
  const saleFlags = ['saleActive', 'isOpen', 'mintOpen', 'mintActive', 'publicSaleActive', 'open', 'mintEnabled', 'saleOpen', 'isActive'].filter((k) => k in reads);
  const ts = (re) => Object.entries(reads).find(([k, v]) => re.test(k) && typeof v === 'bigint' && v > 1_600_000_000n && v < 2_200_000_000n);
  const stT = ts(/^(startTime|startAt|saleStart|mintStart|launchAt|openTime)$/i), enT = ts(/^(endTime|endAt|saleEnd|deadline)$/i);
  let openSummary = paused ? '⛔ 已暂停' : saleFlags.length && saleFlags.every((k) => !truthy(reads[k])) ? '⛔ sale 标志=false' : stT && BigInt(nowTs) < stT[1] ? '⏳ 未开始' : enT && BigInt(nowTs) > enT[1] ? '⛔ 已结束' : '✅ 可 mint(按标志)';
  if (poolOpen) openSummary += '｜市场/池已开';
  poolOpenFlag = poolOpen;
  const soldOut = soldK && capK && /UNITS|MAX_SUPPLY|maxSupply|cap|GEN_TOTAL|totalShares/i.test(capK[0]) && capK[1] > 0n && soldK[1] >= capK[1];
  if (soldOut) openSummary = '⛔ 已售罄 ' + soldK[1] + '/' + capK[1] + (poolOpen ? '｜市场/池已开' : '');
  // ---------- calldata per wallet ----------
  const ctxBase = { shares, token: tokenAddr, costN: costN ?? 0n, unit, valueWei, maxPay, totalMinted: soldK ? soldK[1] : 0n };
  let calldataMode = null, confidence = 'low', argNotes = [];
  const recentT = mf && recent.txs?.filter((t) => t.selector === mf.selector && t.input).slice(-1)[0];
  const buildFor = (w) => {
    const c = { ...ctxBase, self: w.addr };
    if (!mf) return null;
    if (tpl?.needsProject && recentT) { calldataMode = 'recent-tx-replay(' + tpl.family + ')'; confidence = 'medium'; argNotes = ['复用最近成功tx calldata(替换自己地址)；项目参数需官方工具重新生成']; return fillTx(templFromTx(recentT.input, recentT.from), w.addr); }
    if (tpl) { calldataMode = 'template:' + tpl.family; confidence = tpl.needsProject ? 'medium' : 'high'; return encode(tpl.sig, tpl.args(c)); }
    if (mf.sig && !/^0x/.test(mf.sig)) {
      const b = buildArgs(mf.sig, mf.inputs, c);
      if (b.confidence !== 'high' && recentT) { calldataMode = 'recent-tx-replay'; confidence = 'medium'; argNotes = ['复用最近成功tx calldata(替换自己地址)']; return fillTx(templFromTx(recentT.input, recentT.from), w.addr); }
      calldataMode = 'generic-builder'; confidence = b.confidence; argNotes = b.notes; return encode(mf.sig, b.args);
    }
    if (recentT) { calldataMode = 'recent-tx-replay'; confidence = 'medium'; return fillTx(templFromTx(recentT.input, recentT.from), w.addr); }
    return null;
  };
  const datas = WALLETS.map(buildFor);
  let simValue = valueWei;
  if (calldataMode === 'recent-tx-replay' && payToken === 'BNB' && costN === null && recentT) simValue = BigInt(recentT.value);
  T.mark('plan');
  // ---------- simulations ----------
  const bal = WALLETS.map((w) => ({ bnb: R('bnb:' + w.id)?.result ? BigInt(R('bnb:' + w.id).result) : 0n, usdt: R('usdt:' + w.id)?.result ? BigInt(R('usdt:' + w.id).result.slice(0, 66)) : 0n }));
  let slots = null;
  if (payTokenAddr && payToken !== 'BNB' && !isFree) slots = await findSlots(payTokenAddr);
  let sims = WALLETS.map(() => null), gas = WALLETS.map(() => null);
  const taxP = flag('--no-tax') ? Promise.resolve(null) : taxEarly && lc(tokenGuess) === lc(tokenAddr) ? taxEarly : withTimeout(tokenTax(tokenAddr).catch((e) => ({ status: 'err ' + e.message })), 8000, { status: 'timeout' });
  if (mf && datas[0]) {
    const txs = WALLETS.map((w, i) => {
      const ov = { [w.addr]: { balance: '0x' + (bal[i].bnb + simValue + 10n ** 17n).toString(16) } };
      if (slots && payTokenAddr) Object.assign(ov, erc20Override(payTokenAddr, slots, w.addr, mint, (payAmount * 3n) + 10n ** 18n));
      return { from: w.addr, to: mint, data: datas[i], value: simValue, overrides: ov };
    });
    [sims, gas] = await Promise.all([simulate(txs), estimateGas(txs.map((t) => ({ ...t, overrides: undefined })))]);
  }
  T.mark('sims');
  // ---------- risk ----------
  const tax = await taxP;
  const risks = staticRisks({ fp, sigmap: sm, reads, verified: A.src.verified });
  const perSimRisk = sims.map((s, i) => (s?.logs ? simRisks({ wallet: WALLETS[i].addr, logs: s.logs, mint, payToken: payTokenAddr || 'BNB', valueWei: simValue, expectedPay: payAmount, knownSafe: [tokenAddr, ...(Object.values(reads).filter(isAddr))] }) : null));
  const seenR = new Set();
  for (const p of perSimRisk) for (const r of p?.risks || []) if (!seenR.has(r.code + r.msg)) { seenR.add(r.code + r.msg); risks.push(r); }
  const sr0 = perSimRisk.find((p) => p);
  if (sr0?.mintedElsewhere?.length) risks.push({ level: 'high', code: 'mint-to-other', msg: '铸造资产转给非调用者: ' + sr0.mintedElsewhere.map((t) => t.to).join(',') });
  if (sr0?.nativeRecipients?.length) risks.push({ level: 'info', code: 'bnb-forward', msg: 'mint 内 BNB 转给: ' + sr0.nativeRecipients.slice(0, 3).join(',') });
  if (payToken !== 'BNB' && !isFree && payAmount > 0n) risks.push({ level: 'info', code: 'approve-needed', msg: `需 approve ${payToken} 给 ${short(mint)} 精确额度 ${fmtUnits(payAmount)}（禁止 MaxUint）` });
  if (payToken === 'BNB' && valueWei > 5n * 10n ** 17n) risks.push({ level: 'high', code: 'high-value', msg: `单号 value ${fmtUnits(valueWei)} BNB 偏高` });
  if (rec?.price?.unitWei && unit !== null && BigInt(rec.price.unitWei) > 0n) { const d = Number(((unit - BigInt(rec.price.unitWei)) * 1000n) / BigInt(rec.price.unitWei)) / 10; if (Math.abs(d) > 20) risks.push({ level: 'med', code: 'price-changed', msg: `单价较历史变化 ${d}%` }); }
  if (tax?.honeypot) risks.push({ level: 'high', code: 'token-tax', msg: `代币 ${tax.honeypot} ${tax.status} sellTax=${tax.sellTaxPct}%` });
  if (agentGate) risks.push({ level: 'info', code: 'agent-id', msg: '需要 Agent ID（SPACE ID）' });
  if (tpl?.needsProject) risks.push({ level: 'info', code: 'project-args', msg: tpl.needsProject });
  T.mark('risk');
  // ---------- per-wallet table ----------
  const gasEach = gas.map((g, i) => g?.ok ? g.gas : sims[i]?.gasUsed || null);
  const rows = WALLETS.map((w, i) => {
    const s = sims[i], g = gas[i];
    const needBnb = simValue + BigInt(gasEach[i] || 300000) * gasPrice;
    const enoughBnb = bal[i].bnb >= needBnb;
    const enoughPay = payToken === 'USDT' ? bal[i].usdt >= payAmount : true;
    const expected = tpl?.expectRevert && s && !s.ok && tpl.expectRevert.test(s.err || '');
    return { wallet: w.id, addr: w.addr, eligible: s ? (s.ok ? 'OK' : expected ? 'OK*' : s.err) : 'n/a', simReal: g ? (g.ok ? `gas ${g.gas}` : g.err) : 'n/a', gasUsed: s?.gasUsed || null, bnb: fmtUnits(bal[i].bnb, 18, 5), usdt: fmtUnits(bal[i].usdt, 18, 2), needBnb: fmtUnits(needBnb, 18, 6), enoughBnb, enoughPay, agentId: agentBal[i] === null ? null : Number(agentBal[i]), perWallet: Object.fromEntries(Object.entries(perWallet).map(([k, v]) => [k, typeof v[i] === 'bigint' ? v[i].toString() : v[i]])) };
  });
  // owner-only / not-a-mint verdicts
  const allOwnerOnly = sims.every((s) => s && !s.ok && /owner|Ownable|unauthori|AccessControl|not admin/i.test(s.err || ''));
  let verdict = null;
  const knownName = KNOWN[lc(mint)];
  if (A.pair) verdict = `非 Mint 合约（Pancake/Uniswap V2 LP pair${reads.token0 ? ' ' + short(reads.token0) + '/' + short(reads.token1) : ''}；mint(address) 是 LP 铸造）`;
  else if (!mf) verdict = A.pair ? '非 Mint 合约（LP pair）' : A.erc20 ? '非 Mint 合约（普通 ERC20 代币，无公开 mint）' : '未识别到 mint 函数';
  else if (knownName && A.erc20) verdict = `非 Mint 合约（已知代币 ${knownName}；mint 为 owner-only）`;
  else if (allOwnerOnly) verdict = '非公开 Mint（mint 仅 owner 可调用）';
  const tokOf = H.loadAll().find((r) => lc(r.token) === lc(mint));
  if (tokOf && (A.erc20 || verdict)) verdict = `这是 ${tokOf.name} 的代币合约，mint 合约是 ${tokOf.mintContract}（请对 mint 合约预检）`;
  const simOk = rows.filter((r) => r.eligible === 'OK' || r.eligible === 'OK*').length;
  const errsAll = rows.map((r) => String(r.eligible)).join(' ');
  if (simOk === 0 && mf && /quota|perwallet|exceedsWallet|WalletLimit|AlreadyMinted|AlreadyClaimed|no pens/i.test(errsAll)) openSummary += '｜四号额度已用完/已领过';
  else if (poolOpenFlag && simOk === 0 && mf && !/售罄/.test(openSummary)) openSummary = '⛔ 池/市场已开 + 四号 sim 全失败 → mint 大概率已结束';
  const unexplained = sims.filter((s) => s && !s.ok && /未知自定义错误|revert\(无原因\)|no result/.test(s.err || '')).length;
  const needsAI = !verdict || /未识别/.test(verdict) ? (!mf || (!rec && confidence === 'low') || (simOk === 0 && unexplained > 0) || (!rec && !tpl && simOk === 0)) : false;
  // ---------- assemble ----------
  Object.assign(out, {
    status: verdict ? 'not-mint' : 'ok',
    verdict,
    project: opt('--name') || (rec && lc(rec.mintContract) === lc(mint) ? rec.name : null) || disc.title || A.src.name || knownName || short(mint),
    mint: mf ? { sig: mf.sig, selector: mf.selector, name: mf.name, calldataMode, confidence, argNotes, template: tpl?.family || null, recentUses: recent.counts?.[mf.selector] || 0, payable: sm[mf.selector]?.stateMutability === 'payable' ? true : sm[mf.selector]?.stateMutability ? false : null } : null,
    calldata: { to: mint, dataW1: datas[0] && datas[0].length > 1200 ? datas[0].slice(0, 1200) + '…' : datas[0], valueWei: simValue.toString(), value: fmtUnits(simValue), note: '数据中自己地址已按每号替换；执行前必须重新预检' },
    price: { unitWei: unit?.toString() ?? null, unit: unit !== null ? fmtUnits(unit) : null, payToken, payTokenAddr, payWhy, source: priceSrc, siteHint: priceHint, shares: Number(shares), sharesRequested: Number(shares0), costN: costN !== null ? fmtUnits(costN) : null, perWallet: payToken === 'BNB' ? fmtUnits(simValue) + ' BNB' : fmtUnits(payAmount) + ' ' + payToken, total4: payToken === 'BNB' ? fmtUnits(simValue * 4n) + ' BNB' : fmtUnits(payAmount * 4n) + ' ' + payToken, maxTx: maxTx ? String(maxTx[1]) : null },
    progress: { sold: soldK ? `${soldK[0]}=${soldK[1]}` : null, cap: capK ? `${capK[0]}=${capK[1]}` : null, pct: soldK && capK && capK[1] > 0n ? Number((soldK[1] * 10000n) / capK[1]) / 100 : null, all: Object.fromEntries(supKeys.slice(0, 10).map(([k, v]) => [k, v.toString()])) },
    open: { summary: openSummary, poolOpen, paused, flags: st.slice(0, 8), api: apiStatus, now: new Date(nowTs * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)' },
    invite: { fns: fnBy(/invit|referr|^ref|extraQuota|bonus|claimReferral/i).map(([, v]) => v.name).slice(0, 6), refArg: !!(mf && (/address/.test(mf.sig) && (tpl ? /ref/.test(tpl.note || 'ref') : true))) },
    agentGate, wallets: rows, simOk,
    simEffects: perSimRisk.map((p, i) => p && { w: WALLETS[i].id, pays: p.outflows.map((t) => `${t.kind === 'native' ? 'BNB' : KNOWN[lc(t.token)] || short(t.token)} ${fmtUnits(t.amount)}→${short(t.to)}`), receives: p.got.map((t) => `${t.kind === 'native' ? 'BNB' : KNOWN[lc(t.token)] || short(t.token)} ${t.kind === 'erc721' ? '#' + t.id : fmtUnits(t.amount)}`) }).filter(Boolean),
    tokenTax: tax, risks, anomalies,
    needs_ai_analysis: needsAI,
    reads: Object.fromEntries(Object.entries(reads).slice(0, 80).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(String) : v])),
    nReads: Object.fromEntries(Object.entries(nReads).map(([k, v]) => [k, { one: v.one?.toString?.() ?? v.one, n: v.n?.toString?.() ?? v.n, errN: v.errN }])),
  });
  for (const r of risks) if (r.level === 'high') anomalies.push(r.msg);
  if (simOk === 0 && mf && !verdict) anomalies.push('四号模拟全部失败：' + [...new Set(rows.map((r) => r.eligible))].join(' / '));
  // ---------- AI bundle ----------
  if (needsAI) {
    const bundle = {
      target, mint, fingerprint: out.fingerprint, verifiedSource: A.src.verified ? 'sourcify:' + A.src.match : 'none',
      functions: Object.entries(sm).map(([s, v]) => `${s} ${v.sig || '?'}${v.stateMutability ? ' ' + v.stateMutability : ''}`),
      errors: fp.pushed4.map((s) => `${s} ${sigdb.name1(s) || '?'}`),
      embeddedAddrs: fp.addrs.map((a) => `${a}${KNOWN[lc(a)] ? ' ' + KNOWN[lc(a)] : ''}`),
      reads: out.reads, nReads: out.nReads, mintCandidates: out.mintCandidates, recentTx: recent.txs?.slice(-3).map((t) => ({ ...t, input: t.input?.length > 3000 ? t.input.slice(0, 3000) + '…' : t.input })), sims: rows.map((r) => ({ w: r.wallet, eligible: r.eligible, real: r.simReal })),
      site: { title: disc.title, sigs: disc.sigs.slice(0, 40), selLits: disc.selLits.slice(0, 20), priceHints: disc.priceHints.slice(0, 6).map((h) => h.ctx), candidates: out.discovery.top },
      ask: '识别 mint 函数/参数含义/支付币/单价/资格条件；给出 calldata 模板与 value 计算方式；指出风险',
    };
    mkdirSync(ROOT + '/bundles', { recursive: true });
    const f = `${ROOT}/bundles/${localTs}-${String(out.project).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 30)}.json`;
    writeFileSync(f, bigJson(bundle));
    out.aiBundle = f;
  }
  out._hist = { fp, sm, rec, best, disc, recent, sources: [...new Set([...disc.fetched.filter((f) => f.status === 200 && ((disc.candidates.find((c) => lc(c.addr) === lc(mint))?.srcs || []).includes(f.path) || /status|state|llms|config/i.test(f.path))).map((f) => f.path), ...(rec && lc(rec.mintContract) === lc(mint) ? rec.discovery?.sourcePaths || [] : [])])].slice(0, 8) };
  return finish();
}

function finish() {
  out.timing = { ...T.stages, total: T.total() };
  out.rpc = { requests: rpcStats.requests, calls: rpcStats.calls, failovers: rpcStats.failovers };
  const h = out._hist; delete out._hist;
  // history write
  if (!flag('--no-history-write') && out.mintContract && h) {
    const existing = H.loadAll().find((r) => lc(r.mintContract) === lc(out.mintContract));
    const sigNames = Object.fromEntries(Object.entries(h.sm).filter(([, v]) => v.sig).map(([s, v]) => [s, v.sig]));
    const rec = {
      id: existing?.id, name: existing?.name || out.project, url: existing?.url || (isAddr(target) ? null : target), mintContract: out.mintContract, token: out.token,
      proxyImpl: h.fp.impl || null,
      fingerprint: { codeHash: h.fp.codeHash, normHash: h.fp.normHash, impl: h.fp.impl, implCodeHash: h.fp.implCodeHash, implNormHash: h.fp.implNormHash, selectors: h.fp.selectors, proxyType: h.fp.proxyType },
      sigNames,
      mintSelector: out.mint?.selector || existing?.mintSelector, mintSig: out.mint?.sig || existing?.mintSig,
      calldataTemplate: out.mint ? { mode: out.mint.calldataMode, template: out.mint.template, notes: out.mint.argNotes } : existing?.calldataTemplate,
      price: { unitWei: out.price?.unitWei, payToken: out.price?.payToken, source: out.price?.source },
      inviteMechanism: existing?.inviteMechanism || (out.invite?.fns?.length ? out.invite.fns.join(',') : null),
      approveRequired: out.price && out.price.payToken !== 'BNB' && !/FREE/.test(out.price.payToken) ? `exact ${out.price.payToken}` : 'none',
      gasUsed: out.wallets?.find((w) => w.gasUsed)?.gasUsed || existing?.gasUsed || null,
      outcome: existing?.outcome || (out.status === 'not-mint' ? 'not-mint' : 'sim-only'),
      discovery: { sourcePaths: h.sources?.length ? h.sources : existing?.discovery?.sourcePaths },
      runs: [{ at: out.startedAt, simOk: out.simOk, totalMs: out.timing.total, timing: out.timing, match: out.historyMatch?.kind || null }],
    };
    if (out.status !== 'not-mint' || existing) { const saved = H.upsert(rec); out.historyId = saved.id; }
  }
  mkdirSync(ROOT + '/runs', { recursive: true });
  const runFile = `${ROOT}/runs/${localTs}-${String(out.project || 'x').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 30)}.json`;
  out.runFile = runFile;
  writeFileSync(runFile, bigJson(out));
  if (JSON_OUT) console.log(bigJson(out));
  else console.log(report(out));
}

function report(o) {
  const L = [];
  const lv = { high: '🔴', med: '🟠', info: '⚪' };
  L.push(`【BSC Mint 预检】${o.project || ''}  （只读：未签名/未授权/未付款）`);
  if (o.verdict) L.push(`结论：${o.verdict}`);
  L.push(`合约：${o.mintContract || '-'}${o.fingerprint?.proxyType ? ` [${o.fingerprint.proxyType}→${short(o.fingerprint.impl)}]` : ''}${o.fingerprint?.verified ? ' ✅sourcify' : ''}  token：${o.token || '-'}`);
  if (o.verdict) {
    if (o.mint) L.push(`函数：${o.mint.sig}（四号 sim：${[...new Set(o.wallets.map((w) => String(w.eligible).slice(0, 50)))].join(' / ')}）`);
    L.push(`历史匹配：${o.historyMatch ? o.historyMatch.name + ' ' + o.historyMatch.kind : '无'}｜耗时 总 ${o.timing?.total}ms`);
    L.push(`记录：${o.runFile}`);
    return L.join('\n');
  }
  if (o.mint) L.push(`函数：${o.mint.sig} ${o.mint.selector}  [${o.mint.calldataMode || '-'}｜置信 ${o.mint.confidence}${o.mint.recentUses ? `｜近期调用 ${o.mint.recentUses}` : ''}]${o.mint.argNotes?.length ? ' 注:' + o.mint.argNotes.join(';') : ''}`);
  if (o.price) L.push(`单价：${o.price.unit ?? '?'} ${o.price.payToken}（来源 ${o.price.source || '-'}${o.price.siteHint ? '｜站点 ' + o.price.siteHint : ''}）｜份数 ${o.price.shares}${o.price.maxTx ? `(单笔上限 ${o.price.maxTx})` : ''}｜每号 ${o.price.perWallet}｜四号 ${o.price.total4}`);
  if (o.progress) L.push(`进度：${o.progress.sold || '-'} / ${o.progress.cap || '-'}${o.progress.pct !== null ? ` (${o.progress.pct}%)` : ''}`);
  if (o.open) L.push(`开放：${o.open.summary} ｜ ${o.open.flags.join(' ') || '-'}${o.open.api?.length ? ' ｜ ' + o.open.api.join(' ') : ''}`);
  if (o.invite) L.push(`邀请：${o.invite.fns.length ? '有 ' + o.invite.fns.join(',') : '未发现邀请函数'}${o.agentGate ? '｜需 Agent ID' : ''}`);
  if (o.wallets) {
    L.push('号｜资格(sim覆盖余额)｜sim(真实状态 estimateGas)｜BNB｜USDT｜够?' + (o.wallets.some((w) => w.eligible === 'OK*') ? '  (OK*=到达项目预期revert，资格闸已过)' : ''));
    const qk = (w) => Object.entries(w.perWallet || {}).filter(([k, v]) => v !== null && v !== 'ERR' && /left|remain|quota|minted|extra|paid|claimed|bound|agentOf/i.test(k)).slice(0, 3).map(([k, v]) => `${k}=${String(v).slice(0, 12)}`).join(',');
    for (const w of o.wallets) L.push(`${w.wallet}｜${String(w.eligible).slice(0, 48)}${qk(w) ? ' [' + qk(w) + ']' : ''}｜${String(w.simReal).slice(0, 48)}｜${w.bnb}｜${w.usdt}｜${w.enoughBnb && w.enoughPay ? '✅' : '❌' + (!w.enoughBnb ? ' BNB需' + w.needBnb : '') + (!w.enoughPay ? ' ' + o.price.payToken + '不足' : '')}${w.agentId !== null && o.agentGate ? '｜AgentID=' + w.agentId : ''}`);
  }
  if (o.tokenTax) L.push(`代币池：${o.tokenTax.status || '-'}${o.tokenTax.buyTaxPct !== undefined && o.tokenTax.buyTaxPct !== null ? ` 买税≈${o.tokenTax.buyTaxPct}%` : ''}${o.tokenTax.sellTaxPct !== undefined && o.tokenTax.sellTaxPct !== null ? ` 卖税≈${o.tokenTax.sellTaxPct}%` : ''}`);
  if (o.risks?.length) L.push('风险：' + o.risks.filter((r) => r.level !== 'info' || /approve|agent|project/.test(r.code)).map((r) => `${lv[r.level]}${r.msg}`).join('；'));
  if (o.anomalies?.length) L.push('⚠️异常：' + [...new Set(o.anomalies)].join('；'));
  L.push(`历史匹配：${o.historyMatch ? `${o.historyMatch.name}（${o.historyMatch.kind}，相似度 ${o.historyMatch.similarity}，上次结果 ${o.historyMatch.outcome || '-'}）` : '无'}${o.historyMatch?.lessons?.length ? '｜经验:' + o.historyMatch.lessons.slice(0, 2).join('；') : ''}`);
  if (o.needs_ai_analysis) L.push(`🤖 needs_ai_analysis=true → ${o.aiBundle}`);
  const t = o.timing || {};
  L.push(`耗时：发现${t.discovery ?? '-'}｜指纹${t.fingerprint ?? '-'}｜匹配${t.historyMatch ?? '-'}｜签名${t.signatures ?? '-'}｜读取${t.reads ?? '-'}｜模拟${t.sims ?? '-'}｜风险${t.risk ?? '-'}｜总 ${t.total}ms（RPC ${o.rpc?.requests}次/${o.rpc?.calls}调用）`);
  L.push(`记录：${o.runFile}${o.historyId ? '｜history ' + o.historyId : ''}`);
  return L.join('\n');
}

main().catch((e) => { out.status = 'error'; out.error = String(e.stack || e).slice(0, 800); out.timing = { total: T.total() }; console.log(JSON_OUT ? bigJson(out) : '预检失败: ' + out.error); process.exit(1); });
