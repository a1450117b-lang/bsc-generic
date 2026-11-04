#!/usr/bin/env node
// History library CLI: add | list | show | update-outcome | match | compact
import * as H from './lib/history.mjs';
import { fingerprint } from './lib/fingerprint.mjs';
import * as sigdb from './lib/sigdb.mjs';
import { lc, isAddr, short, bigJson } from './lib/util.mjs';
const [cmd, ...rest] = process.argv.slice(2);
const opts = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; if (k === 'lesson') (opts.lesson ||= []).push(v); else opts[k] = v; }
  else pos.push(a);
}
const find = (q) => { const all = H.loadAll(); q = lc(q); return all.find((r) => r.id === q || lc(r.mintContract) === q || lc(r.name).includes(q) || (r.url && lc(r.url).includes(q))); };
export async function fpRecord(ca) {
  const fp = await fingerprint(ca);
  if (!fp.isContract) throw new Error('not a contract: ' + ca);
  await sigdb.resolve(fp.selectors);
  const sigNames = Object.fromEntries(fp.selectors.map((s) => [s, sigdb.name1(s)]).filter(([, v]) => v));
  return { proxyImpl: fp.impl || null, fingerprint: { codeHash: fp.codeHash, normHash: fp.normHash, impl: fp.impl, implCodeHash: fp.implCodeHash, implNormHash: fp.implNormHash, selectors: fp.selectors, proxyType: fp.proxyType }, sigNames };
}
async function main() {
  if (cmd === 'add') {
    let rec = opts.json ? JSON.parse(opts.json) : {};
    for (const k of ['name', 'url', 'token', 'outcome', 'mintSig', 'mintSelector', 'failureReason', 'inviteMechanism', 'approveRequired']) if (opts[k]) rec[k] = opts[k];
    rec.mintContract = opts.ca || rec.mintContract;
    if (!isAddr(rec.mintContract)) throw new Error('--ca <mint contract> required');
    if (opts.lesson) rec.lessons = [...(rec.lessons || []), ...opts.lesson];
    if (!opts['no-fingerprint']) Object.assign(rec, await fpRecord(rec.mintContract));
    const ex = H.loadAll().find((r) => lc(r.mintContract) === lc(rec.mintContract));
    const saved = H.upsert({ ...rec, id: ex?.id, outcome: rec.outcome || ex?.outcome || 'sim-only' });
    console.log('saved', saved.id, saved.outcome, (saved.fingerprint?.selectors || []).length + ' selectors');
  } else if (cmd === 'list') {
    const all = H.loadAll().filter((r) => !opts.outcome || r.outcome === opts.outcome);
    for (const r of all) console.log(`${r.id.padEnd(34)} ${String(r.outcome).padEnd(9)} ${short(r.mintContract)} ${(r.mintSig || '-').slice(0, 52).padEnd(52)} ${r.price?.payToken || ''} ${r.price?.unit || r.price?.unitWei || ''}`);
    console.log(all.length + ' records');
  } else if (cmd === 'show') {
    const r = find(pos[0] || ''); if (!r) throw new Error('not found');
    const { sigNames, fingerprint: f, ...rest2 } = r;
    console.log(bigJson({ ...rest2, fingerprint: { ...f, selectors: (f?.selectors || []).length + ' selectors' }, sigNames: Object.keys(sigNames || {}).length + ' names' }));
  } else if (cmd === 'update-outcome') {
    const r = find(pos[0] || ''); if (!r) throw new Error('not found');
    const outcome = pos[1]; if (!/^(success|fail|cancelled|sim-only|partial|not-mint)$/.test(outcome || '')) throw new Error('outcome: success|fail|cancelled|sim-only|partial|not-mint');
    const upd = { id: r.id, outcome, outcomeAt: new Date().toISOString() };
    if (opts.reason) upd.failureReason = opts.reason; else if (outcome === 'success') upd.failureReason = null;
    if (opts.lesson) upd.lessons = opts.lesson;
    if (opts.gas) upd.gasUsed = Number(opts.gas);
    if (opts.tx) upd.txs = [...(r.txs || []), opts.tx];
    if (opts.cost) upd.actualCost = opts.cost;
    const s = H.upsert(upd); console.log('updated', s.id, s.outcome, s.failureReason || '');
  } else if (cmd === 'match') {
    const fp = await fingerprint(pos[0]);
    const m = H.match(fp);
    console.log(m.length ? m.map((x) => `${x.name} ${x.kind} ${x.score}`).join('\n') : 'no match');
  } else if (cmd === 'compact') console.log('records', H.compact());
  else console.log('usage: history.mjs add --ca 0x.. --name X [--url] [--outcome] [--lesson ".."] | list [--outcome] | show <id|addr|name> | update-outcome <id|addr|name> <success|fail|cancelled|sim-only|partial> [--reason] [--lesson] [--gas] [--tx] | match <CA> | compact');
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
