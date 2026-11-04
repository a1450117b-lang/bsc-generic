// Site discovery: fetch HTML/bundles/configs, extract addresses with context, ABI fragments, price hints.
import { fetchText, isAddr, lc, KNOWN, now } from './util.mjs';
export const WELL_KNOWN = ['/deployment.json', '/data/deployment.json', '/assets/deployment.json', '/config.json', '/config.js', '/assets/config.js', '/js/config.js',
  '/chain/config.json', '/mint/chain/config.json', '/contracts.json', '/addresses.json', '/llms.txt', '/skill/SKILL.md', '/SKILL.md', '/skill.md',
  '/api/status', '/api/config', '/api/contracts', '/app.js', '/assets/app.js', '/js/app.js', '/manifest.json'];
const ROLE_POS = /(mint|launch|core|sale|presale|minter|nft|project|genesis|contract|forge|drop|claim|controller|game|pad)/i;
const ROLE_NEG = /(claimant|holder|user|account|sender|player|buyer|winner|inviter|referrer|token|pair|usdt|usdc|busd|wbnb|weth|router|factory|treasury|signer|oracle|publisher|burn|dead|registry|agentid|idcollection|owner|marketing|fee|tax|multicall|source|beneficiar|recipient|deployer|admin|wallet|lp)/i;
function keyBefore(text, idx) {
  const pre = text.slice(Math.max(0, idx - 90), idx);
  const m = pre.match(/([A-Za-z_$][\w$\-]*)["'`]?\s*[:=]\s*(?:\{\s*["']?address["']?\s*:\s*)?["'`]?\s*$/);
  if (m) return m[1];
  const m2 = pre.match(/([A-Za-z_$][\w$\- ]{2,30})[^A-Za-z0-9_$]{0,12}$/);
  return m2 ? m2[1].trim() : '';
}
function walkJson(o, path, out) {
  if (o === null || o === undefined) return;
  if (typeof o === 'string') { if (isAddr(o)) out.push({ addr: o, key: path.join('.') }); return; }
  if (Array.isArray(o)) { o.forEach((v, i) => walkJson(v, [...path, String(i)], out)); return; }
  if (typeof o === 'object') for (const [k, v] of Object.entries(o)) walkJson(v, [...path, k], out);
}
export function extract(text, src) {
  const addrs = [];
  let json = null;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { json = JSON.parse(t); } catch {} }
  if (json) { const o = []; walkJson(json, [], o); for (const x of o) addrs.push({ ...x, src, kind: 'json' }); }
  else {
    const re = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;
    let m;
    while ((m = re.exec(text))) addrs.push({ addr: m[0], key: keyBefore(text, m.index), src, kind: 'text' });
  }
  // ABI fragments
  const sigs = new Set();
  for (const m of text.matchAll(/["'`]function\s+([A-Za-z_]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const types = m[2].split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
    if (types.every((x) => /^(u?int\d*|address|bool|bytes\d*|string|tuple|\(.*\))(\[\d*\])*$/.test(x))) sigs.add(`${m[1]}(${types.join(',')})`);
  }
  const abiNames = new Set();
  for (const m of text.matchAll(/["']?name["']?\s*:\s*["']([A-Za-z_]\w*)["'][^{}]{0,400}?["']?type["']?\s*:\s*["']function["']/g)) abiNames.add(m[1]);
  for (const m of text.matchAll(/["']?type["']?\s*:\s*["']function["'][^{}]{0,80}?["']?name["']?\s*:\s*["']([A-Za-z_]\w*)["']/g)) abiNames.add(m[1]);
  // selector literals with names, e.g. mint:"0xe38fd349"
  const selLits = [];
  for (const m of text.matchAll(/([A-Za-z_]\w*)["']?\s*[:=]\s*["'](0x[0-9a-fA-F]{8})["']/g)) selLits.push({ name: m[1], selector: m[2].toLowerCase() });
  // price hints: "0.01 USDT per ticket", "PRICE = 0.002", basePriceWei
  const priceHints = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(USDT|BNB|USDC|BUSD)\b(?:\s*(?:\/|per|each|每)\s*(ticket|share|mint|unit|nft|份|张|个|次))?/gi)) priceHints.push({ amount: m[1], token: m[2].toUpperCase(), per: m[3] || '', ctx: text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' '), src });
  for (const m of text.matchAll(/(BASE_PRICE(?:_BNB|_WEI)?|basePriceWei|MINT_PRICE|PRICE|price)\s*[:=]\s*["']?([\d.]+(?:e\d+)?)n?["']?/g)) priceHints.push({ key: m[1], raw: m[2], src });
  const links = [];
  for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"'#]+\.(?:js|json|md|txt)(?:\?[^"']*)?)["']/gi)) links.push(m[1]);
  for (const m of text.matchAll(/["'`](\/?(?:assets|static|_next\/static\/chunks|js|dist|build|data|config|chain)\/[\w\-./]+\.(?:js|json))["'`]/g)) links.push(m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+\.(?:json|js|md|txt)\b/g)) links.push(m[0]);
  const title = (text.match(/<title>([^<]{1,80})<\/title>/i) || [])[1] || (json && (json.name || json.project || json.brand)) || (text.match(/^#\s+(.{1,60})$/m) || [])[1] || null;
  return { addrs, sigs: [...sigs], abiNames: [...abiNames], selLits, priceHints, links, title, json };
}
/** Discover candidates from URL. opts.fastPaths: paths from history to try first. */
export async function discover(input, opts = {}) {
  const t0 = now();
  const out = { input, base: null, candidates: [], sigs: [], abiNames: [], selLits: [], priceHints: [], fetched: [], title: null, jsons: {} };
  if (isAddr(input)) { out.candidates = [{ addr: input, score: 100, keys: ['cli'], srcs: ['cli'] }]; out.ms = Math.round(now() - t0); return out; }
  const u = new URL(input.includes('://') ? input : 'https://' + input);
  const base = `${u.protocol}//${u.host}`;
  out.base = base; out.host = u.host;
  const pathAddr = (u.pathname + u.search + u.hash).match(/0x[a-fA-F0-9]{40}/g) || [];
  const seen = new Set();
  const all = [];
  const ingest = (r, path) => {
    out.fetched.push({ path, status: r.status, bytes: r.text.length, ms: r.ms });
    if (!r.ok || !r.text || /^\s*<!doctype html/i.test(r.text) && path !== '/' && path !== u.pathname && !/\.html?$/.test(path) && r.ct.includes('html') && r.text.length < 400) return null;
    const ex = extract(r.text, path);
    if (ex.json) out.jsons[path] = ex.json;
    all.push(...ex.addrs);
    out.sigs.push(...ex.sigs); out.abiNames.push(...ex.abiNames); out.selLits.push(...ex.selLits); out.priceHints.push(...ex.priceHints);
    if (!out.title && ex.title) out.title = ex.title;
    return ex;
  };
  const get = async (p) => { const url = p.startsWith('http') ? p : base + (p.startsWith('/') ? p : '/' + p); if (seen.has(url)) return null; seen.add(url); const r = await fetchText(url, opts.timeoutMs || 4000); return { r, p: p.startsWith('http') ? p.replace(base, '') : p }; };
  // wave 1: page + well-known (+ fast paths from history first)
  const wave1 = [...new Set([...(opts.fastPaths || []), u.pathname || '/', '/', ...(opts.fastOnly ? ['/api/status', '/llms.txt', '/deployment.json'] : WELL_KNOWN)])];
  const r1 = (await Promise.all(wave1.map(get))).filter(Boolean);
  const links = new Set();
  // SPA fallbacks return index.html for any path: detect by identical body to "/"
  const rootBody = r1.find((x) => x.p === '/')?.r.text;
  for (const { r, p } of r1) {
    if (p !== '/' && rootBody && r.text === rootBody) { out.fetched.push({ path: p, status: 'spa-fallback' }); continue; }
    const ex = ingest(r, p);
    if (ex) for (const l of ex.links) links.add(l);
  }
  // wave 2: linked same-origin JS/JSON/MD (bundles), max 14
  const sameOrigin = [...links].map((l) => { try { const x = new URL(l, base + '/'); return x.host === u.host ? x.pathname + x.search : null; } catch { return null; } }).filter(Boolean);
  const wave2 = sameOrigin.filter((p) => !seen.has(base + p)).slice(0, 14);
  if (wave2.length && !(opts.fastOnly && all.length)) {
    const r2 = (await Promise.all(wave2.map(get))).filter(Boolean);
    const links3 = new Set();
    for (const { r, p } of r2) { if (rootBody && r.text === rootBody) continue; const ex = ingest(r, p); if (ex && /\.js/.test(p)) for (const l of ex.links) if (/\.js/.test(l)) links3.add(l); }
    // wave 3: chunk imports from bundles, only if no strong candidate yet
    const strong = all.some((a) => ROLE_POS.test(a.key) && !KNOWN[lc(a.addr)]);
    if (!strong) {
      const p3 = [...links3].map((l) => { try { const x = new URL(l, base + '/'); return x.host === u.host ? x.pathname + x.search : null; } catch { return null; } }).filter((p) => p && !seen.has(base + p)).slice(0, 12);
      const r3 = (await Promise.all(p3.map(get))).filter(Boolean);
      for (const { r, p } of r3) ingest(r, p);
    }
  }
  // rank addresses
  const byAddr = new Map();
  for (const p of pathAddr) all.push({ addr: p, key: 'url-path', src: 'url', kind: 'url' });
  for (const a of all) {
    const k = lc(a.addr);
    if (!byAddr.has(k)) byAddr.set(k, { addr: a.addr, keys: new Set(), srcs: new Set(), n: 0 });
    const e = byAddr.get(k); e.keys.add(a.key); e.srcs.add(a.src); e.n++;
  }
  for (const e of byAddr.values()) {
    let s = Math.min(e.n, 5);
    const keys = [...e.keys].join(' ');
    const lastSeg = [...e.keys].map((k) => k.split('.').pop());
    if (lastSeg.some((k) => ROLE_POS.test(k) && !ROLE_NEG.test(k))) s += 40;
    else if ([...e.keys].some((k) => ROLE_POS.test(k))) s += 15;
    if (lastSeg.some((k) => ROLE_NEG.test(k))) s -= 25;
    if ([...e.keys].includes('url-path')) s += 50;
    if ([...e.srcs].some((x) => /deployment|config|contracts|addresses/.test(x))) s += 5;
    if (/signers?\.\d/.test(keys)) s -= 30;
    if (/(^|\.)(recent|history|logs|txs|events|holders|leaderboard|ranking|top|items|list)\.\d/i.test(keys)) s -= 45;
    const known = KNOWN[lc(e.addr)];
    if (known) s -= 100;
    out.candidates.push({ addr: e.addr, score: s, known: known || null, keys: [...e.keys].slice(0, 6), srcs: [...e.srcs].slice(0, 4) });
  }
  out.candidates.sort((a, b) => b.score - a.score);
  out.sigs = [...new Set(out.sigs)]; out.abiNames = [...new Set(out.abiNames)];
  out.ms = Math.round(now() - t0);
  return out;
}
