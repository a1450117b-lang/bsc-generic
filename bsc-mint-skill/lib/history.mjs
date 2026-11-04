// History library: JSONL at history/projects.jsonl. One record per project (latest wins by id).
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { ROOT, lc, jaccard } from './util.mjs';
export const FILE = ROOT + '/history/projects.jsonl';
export function loadAll() {
  if (!existsSync(FILE)) return [];
  const m = new Map();
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); m.set(r.id, { ...(m.get(r.id) || {}), ...r }); } catch {}
  }
  return [...m.values()].filter((r) => !r.deleted);
}
export function idFor(r) { return (r.name || 'x').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') + ':' + lc(r.mintContract || '').slice(2, 10); }
/** append (upsert-by-id). Fields merge; arrays `runs` append. */
export function upsert(rec) {
  const id = rec.id || idFor(rec);
  const prev = loadAll().find((r) => r.id === id);
  const out = { ...(prev || {}), ...rec, id, updatedAt: new Date().toISOString() };
  if (!prev) out.createdAt = out.createdAt || out.updatedAt;
  if (prev?.runs || rec.runs) out.runs = [...(prev?.runs || []), ...(rec.runs || [])].slice(-20);
  if (prev?.lessons && rec.lessons) out.lessons = [...new Set([...prev.lessons, ...rec.lessons])];
  appendFileSync(FILE, JSON.stringify(out) + '\n');
  return out;
}
export function compact() {
  const all = loadAll();
  writeFileSync(FILE, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return all.length;
}
/** Match fingerprint against history. Order: exact code hash > normalized hash > same impl > same address > selector Jaccard. */
export function match(fp, { threshold = 0.6, host } = {}) {
  const all = loadAll();
  const res = [];
  const sels = fp.selectors || [];
  for (const r of all) {
    if (process.env.PRECHECK_IGNORE_SELF && lc(r.mintContract) === lc(fp.address)) continue;
    const f = r.fingerprint || {};
    let kind = null, score = 0;
    const hashes = [fp.codeHash, fp.implCodeHash].filter(Boolean);
    const nh = [fp.normHash, fp.implNormHash].filter(Boolean);
    if (hashes.some((h) => h === f.codeHash || h === f.implCodeHash)) { kind = 'exact-bytecode'; score = 1; }
    else if (nh.some((h) => h === f.normHash || h === f.implNormHash)) { kind = 'normalized-bytecode'; score = 0.97; }
    else if (fp.impl && f.impl && lc(fp.impl) === lc(f.impl)) { kind = 'same-impl'; score = 0.95; }
    else if (f.selectors?.length && sels.length) {
      const j = jaccard(sels, f.selectors);
      if (j >= threshold) { kind = 'selector-jaccard'; score = +j.toFixed(3); }
    }
    if (lc(r.mintContract) === lc(fp.address)) { kind = kind ? kind + '+same-address' : 'same-address'; score = Math.max(score, 0.99); }
    if (!kind && host && r.url && r.url.includes(host)) { kind = 'same-host'; score = 0.3; }
    if (kind) res.push({ id: r.id, name: r.name, kind, score, record: r });
  }
  res.sort((a, b) => b.score - a.score);
  return res.slice(0, 5);
}
