// Bytecode fingerprinting: hashes, proxy detection, PUSH4 selector scan, PUSH20 address scan.
import { batch } from './rpc.mjs';
import { keccak, decAddr, ZERO, lc } from './util.mjs';
export const SLOTS = {
  eip1967Impl: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  eip1822: '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7',
  zosImpl: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
};
/** Walk opcodes; return {selectors, pushed4 (non-dispatch, e.g. errors), addrs (PUSH20), normalized} */
export function scan(code) {
  const b = Buffer.from(code.replace(/^0x/, ''), 'hex');
  // strip CBOR metadata (last 2 bytes = length)
  let end = b.length;
  if (b.length > 2) { const L = b.readUInt16BE(b.length - 2); if (L > 0 && L + 2 < b.length && b[b.length - 2 - L] === 0xa2) end = b.length - 2 - L; }
  const ops = [];
  const norm = Buffer.from(b.subarray(0, end));
  for (let i = 0; i < end; ) {
    const op = b[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      ops.push({ op, i, data: b.subarray(i + 1, i + 1 + n).toString('hex') });
      if (n === 20 || n === 32) norm.fill(0, i + 1, Math.min(end, i + 1 + n)); // immutables / constants
      i += 1 + n;
    } else { ops.push({ op, i }); i++; }
    if (op === 0xfe && i > end * 0.98) break;
  }
  const selectors = new Set(), pushed4 = new Set(), addrs = new Set();
  const byOff = new Map(ops.map((o, k) => [o.i, k]));
  const payable = {};
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    if (o.op === 0x63 && o.data && o.data.length === 8) {
      const v = '0x' + o.data;
      if (v === '0xffffffff' || v === '0x4e487b71' || v === '0x08c379a0') continue;
      const n1 = ops[k + 1]?.op, n2 = ops[k + 2]?.op;
      const isCmp = (x) => x === 0x14 || x === 0x11 || x === 0x10; // EQ GT LT
      if (isCmp(n1) || ((n1 >= 0x80 && n1 <= 0x8f) && isCmp(n2))) {
        selectors.add(v);
        // payability heuristic: EQ PUSHn dest JUMPI → at dest: JUMPDEST ... CALLVALUE within 3 ops => nonpayable
        const eqK = n1 === 0x14 ? k + 1 : n2 === 0x14 ? k + 2 : -1;
        const pj = ops[eqK + 1], ji = ops[eqK + 2];
        if (eqK > 0 && pj && pj.op >= 0x60 && pj.op <= 0x62 && ji?.op === 0x57) {
          const dk = byOff.get(parseInt(pj.data, 16));
          if (dk !== undefined && ops[dk].op === 0x5b) payable[v] = ![1, 2, 3, 4].some((d) => ops[dk + d]?.op === 0x34);
        }
      }
      else pushed4.add(v);
    } else if (o.op === 0x73 && o.data) {
      const a = '0x' + o.data;
      if (!/^0x(0{40}|f{40})$/i.test(a) && !/^0x0{20}/.test(a)) addrs.add(a);
    }
  }
  // error selectors are pushed then shifted; dispatch selectors removed
  for (const s of selectors) pushed4.delete(s);
  const pv = Object.values(payable);
  if (pv.length > 4 && !pv.some((x) => !x)) for (const k of Object.keys(payable)) payable[k] = null; // pattern unreliable for this compiler
  return { payable, selectors: [...selectors].sort(), pushed4: [...pushed4].sort(), addrs: [...addrs], normalized: '0x' + norm.toString('hex') };
}
function minimalProxyTarget(code) {
  const m = code.toLowerCase().match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  return m ? '0x' + m[1] : null;
}
const slotAddr = (r) => { const v = r?.result; if (!v || /^0x0*$/.test(v)) return null; const a = decAddr(v.length < 66 ? '0x' + v.slice(2).padStart(64, '0') : v); return a && lc(a) !== ZERO ? a : null; };
/** Full fingerprint of address (follows one proxy hop). */
export async function fingerprint(address) {
  const res = await batch([
    { method: 'eth_getCode', params: [address, 'latest'] },
    ...Object.values(SLOTS).map((s) => ({ method: 'eth_getStorageAt', params: [address, s, 'latest'] })),
  ]);
  const code = res[0].result || '0x';
  const fp = { address, isContract: code !== '0x' && code.length > 2, codeSize: (code.length - 2) / 2 };
  if (!fp.isContract) return fp;
  const [implS, adminS, beaconS, e1822, zos] = res.slice(1).map(slotAddr);
  let impl = implS || e1822 || zos || minimalProxyTarget(code);
  let proxyType = implS ? 'EIP-1967' : e1822 ? 'EIP-1822' : zos ? 'zos' : minimalProxyTarget(code) ? 'EIP-1167' : null;
  if (!impl && beaconS) {
    const r = await batch([{ method: 'eth_call', params: [{ to: beaconS, data: '0x5c60da1b' }, 'latest'] }]);
    impl = r[0].result && r[0].result.length >= 66 ? decAddr(r[0].result) : null;
    proxyType = 'Beacon';
  }
  Object.assign(fp, { proxyType, impl, admin: adminS, beacon: beaconS });
  const s = scan(code);
  fp.codeHash = keccak(code);
  fp.normHash = keccak(s.normalized);
  fp.payable = s.payable; fp.selectors = s.selectors; fp.pushed4 = s.pushed4; fp.addrs = s.addrs;
  if (impl) {
    const r = await batch([{ method: 'eth_getCode', params: [impl, 'latest'] }]);
    const ic = r[0].result || '0x';
    if (ic.length > 2) {
      const si = scan(ic);
      fp.implCodeHash = keccak(ic); fp.implNormHash = keccak(si.normalized); fp.implCodeSize = (ic.length - 2) / 2;
      fp.proxySelectors = fp.selectors; fp.payable = { ...fp.payable, ...si.payable };
      fp.selectors = [...new Set([...si.selectors, ...fp.selectors])].sort();
      fp.pushed4 = [...new Set([...si.pushed4, ...fp.pushed4])];
      fp.addrs = [...new Set([...si.addrs, ...fp.addrs])];
    }
  }
  return fp;
}
