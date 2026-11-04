// EVM helpers: generic decoding, revert decoding, ERC20 storage-slot discovery, simulation.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ethers, ROOT, lc, pad32, encAddr, encUint, toHex, ZERO } from './util.mjs';
import { batch } from './rpc.mjs';
import { name1 } from './sigdb.mjs';
const coder = ethers.AbiCoder.defaultAbiCoder();
export function decodeGuess(hex, outTypes) {
  if (!hex || hex === '0x') return { v: null };
  if (outTypes && outTypes.length) {
    try { const r = coder.decode(outTypes, hex); return { v: r.length === 1 ? norm(r[0]) : r.map(norm), typed: true }; } catch {}
  }
  const body = hex.slice(2);
  if (body.length === 64) {
    const v = BigInt(hex);
    if (v > 2n ** 100n && v < 2n ** 160n) return { v: ethers.getAddress('0x' + body.slice(24)), kind: 'address' };
    return { v, kind: 'uint' };
  }
  if (body.length >= 128 && BigInt('0x' + body.slice(0, 64)) === 32n) {
    try { const [s] = coder.decode(['string'], hex); if (/^[\x20-\x7e\u00a0-\uffff]*$/.test(s)) return { v: s, kind: 'string' }; } catch {}
  }
  const words = [];
  for (let i = 0; i < Math.min(body.length / 64, 6); i++) words.push(BigInt('0x' + body.slice(i * 64, i * 64 + 64)));
  return { v: words, kind: 'words' };
}
function norm(x) { if (typeof x === 'bigint') return x; if (x && typeof x.toArray === 'function') return x.toArray().map(norm); return x; }
/** decode revert data → human string */
export function decodeRevert(err) {
  if (!err) return null;
  let data = err.data;
  if (data && typeof data === 'object') data = data.data || data.result;
  const msg = err.message || '';
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    const s = data.slice(0, 10).toLowerCase();
    try {
      if (s === '0x08c379a0') return 'Error: ' + (coder.decode(['string'], '0x' + data.slice(10))[0] || '(空)');
      if (s === '0x4e487b71') return 'Panic(0x' + BigInt('0x' + data.slice(10, 74)).toString(16) + ')';
    } catch {}
    const n = name1(s);
    let args = '';
    if (n && /\(.+\)/.test(n)) { try { const types = ethers.FunctionFragment.from('function ' + n).inputs.map((i) => i.type); args = coder.decode(types, '0x' + data.slice(10)).map((x) => String(x)).join(','); } catch {} }
    return n ? n.replace(/\(.*\)$/, '') + (args ? `(${args})` : '()') : `${s} (未知自定义错误)`;
  }
  if (/insufficient funds/i.test(msg)) return 'BNB余额不足(gas+value)';
  if (data === '0x' || (typeof data === 'string' && data.length < 10 && /revert/i.test(msg))) return 'revert(无原因)';
  const m = msg.match(/execution reverted:?\s*(.*)$/i);
  if (m) return m[1] ? 'Error: ' + m[1] : 'revert(无原因)';
  return msg.slice(0, 120) || 'error';
}
// ---------- ERC20 slot discovery (for allowance/balance state overrides) ----------
const SLOT_CACHE = ROOT + '/cache/slots.json';
const slotCache = existsSync(SLOT_CACHE) ? JSON.parse(readFileSync(SLOT_CACHE, 'utf8')) : {};
const OZ5 = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const mapKey = (key, slot) => ethers.keccak256('0x' + pad32(key) + pad32(BigInt(slot).toString(16)));
export const balSlotKey = (owner, slot) => mapKey(lc(owner), slot);
export const allowSlotKey = (owner, spender, slot) => ethers.keccak256('0x' + pad32(lc(spender)) + mapKey(lc(owner), slot).slice(2));
export async function findSlots(token, probeOwner = '0x00000000000000000000000000000000000Ba5e1') {
  const k = lc(token);
  if (slotCache[k]) return slotCache[k];
  const spender = '0x000000000000000000000000000000000000Ab0c';
  const cands = [...Array(12).keys()].map(BigInt).concat([OZ5, OZ5 + 1n]);
  const magic = 0x1234567890abcdefn;
  const calls = [];
  for (const s of cands) {
    calls.push({ method: 'eth_call', params: [{ to: token, data: '0x70a08231' + encAddr(probeOwner) }, 'latest', { [token]: { stateDiff: { [balSlotKey(probeOwner, s)]: '0x' + encUint(magic) } } }] });
    calls.push({ method: 'eth_call', params: [{ to: token, data: '0xdd62ed3e' + encAddr(probeOwner) + encAddr(spender) }, 'latest', { [token]: { stateDiff: { [allowSlotKey(probeOwner, spender, s)]: '0x' + encUint(magic) } } }] });
  }
  const r = await batch(calls);
  let bal = null, allow = null;
  cands.forEach((s, i) => {
    if (bal === null && r[2 * i].result && BigInt(r[2 * i].result.slice(0, 66) || 0) === magic) bal = s.toString();
    if (allow === null && r[2 * i + 1].result && BigInt(r[2 * i + 1].result.slice(0, 66) || 0) === magic) allow = s.toString();
  });
  const out = { bal, allow };
  if (bal !== null || allow !== null) { slotCache[k] = out; try { writeFileSync(SLOT_CACHE, JSON.stringify(slotCache)); } catch {} }
  return out;
}
export function erc20Override(token, slots, owner, spender, amount) {
  const sd = {};
  if (slots.bal !== null && slots.bal !== undefined) sd[balSlotKey(owner, BigInt(slots.bal))] = '0x' + encUint(amount);
  if (spender && slots.allow !== null && slots.allow !== undefined) sd[allowSlotKey(owner, spender, BigInt(slots.allow))] = '0x' + encUint(amount);
  return Object.keys(sd).length ? { [token]: { stateDiff: sd } } : {};
}
// ---------- simulation ----------
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
let simV1 = true;
/** Simulate list of txs [{from,to,data,value}] with overrides. Returns per-call {ok, gasUsed, ret, logs, err}. */
export async function simulate(txs, overrides = {}) {
  if (simV1) {
    const calls = txs.map((t) => [{ blockStateCalls: [{ stateOverrides: { ...overrides, ...(t.overrides || {}) }, calls: [{ from: t.from, to: t.to, data: t.data, value: toHex(t.value || 0n), gas: '0x2faf080' }] }], traceTransfers: true, validation: false }, 'latest']);
    const res = await batch(calls.map((p) => ({ method: 'eth_simulateV1', params: p })));
    if (res.every((r) => r.error && /not (found|supported|exist)|unknown method/i.test(r.error.message))) simV1 = false;
    else return res.map((r) => {
      if (r.error) return { ok: false, err: decodeRevert(r.error), rawErr: r.error.message };
      const c = r.result?.[0]?.calls?.[0];
      if (!c) return { ok: false, err: 'no result' };
      const ok = c.status === '0x1';
      return { ok, gasUsed: c.gasUsed ? Number(BigInt(c.gasUsed)) : null, ret: c.returnData, logs: c.logs || [], err: ok ? null : decodeRevert(c.error ? { ...c.error, data: c.error.data || c.returnData } : { data: c.returnData, message: 'execution reverted' }) };
    });
  }
  const res = await batch(txs.map((t) => ({ method: 'eth_call', params: [{ from: t.from, to: t.to, data: t.data, value: toHex(t.value || 0n) }, 'latest', { ...overrides, ...(t.overrides || {}) }] })));
  return res.map((r) => ({ ok: !r.error, ret: r.result, logs: null, err: r.error ? decodeRevert(r.error) : null }));
}
/** multi-call bundle in one simulated block (sequential). */
export async function simulateBundle(calls, overrides = {}) {
  const r = await batch([{ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ stateOverrides: overrides, calls: calls.map((t) => ({ from: t.from, to: t.to, data: t.data, value: toHex(t.value || 0n), gas: '0x1c9c380' })) }], traceTransfers: true, validation: false }, 'latest'] }]);
  if (r[0].error) return { error: decodeRevert(r[0].error) };
  return { calls: (r[0].result?.[0]?.calls || []).map((c) => ({ ok: c.status === '0x1', ret: c.returnData, gasUsed: c.gasUsed ? Number(BigInt(c.gasUsed)) : null, logs: c.logs || [], err: c.status === '0x1' ? null : decodeRevert({ data: c.returnData, message: c.error?.message }) })) };
}
export async function estimateGas(txs) {
  const res = await batch(txs.map((t) => ({ method: 'eth_estimateGas', params: [{ from: t.from, to: t.to, data: t.data, value: toHex(t.value || 0n) }, 'latest'] })));
  return res.map((r) => (r.error ? { ok: false, err: decodeRevert(r.error) } : { ok: true, gas: Number(BigInt(r.result)) }));
}
export function parseTransfers(logs) {
  const out = [];
  for (const l of logs || []) {
    const t0 = l.topics?.[0];
    if (t0 === TRANSFER_TOPIC && l.topics.length === 3) out.push({ kind: lc(l.address) === NATIVE ? 'native' : 'erc20', token: l.address, from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), amount: l.data && l.data !== '0x' ? BigInt(l.data.slice(0, 66)) : 0n });
    else if (t0 === TRANSFER_TOPIC && l.topics.length === 4) out.push({ kind: 'erc721', token: l.address, from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), id: BigInt(l.topics[3]) });
    else if (t0 === APPROVAL_TOPIC && l.topics.length >= 3) out.push({ kind: 'approval', token: l.address, owner: '0x' + l.topics[1].slice(26), spender: '0x' + l.topics[2].slice(26), amount: l.data && l.data !== '0x' ? BigInt(l.data.slice(0, 66)) : null });
  }
  return out;
}
export { coder, ZERO };
