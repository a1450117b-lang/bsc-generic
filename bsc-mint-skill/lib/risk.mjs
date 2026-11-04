// Risk checks: proxy/admin, owner powers, pausable, black/whitelist, sim transfer analysis, token tax sim.
import { lc, KNOWN, WBNB, USDT, ROUTER, FACTORY, ZERO, encAddr, encUint, fmtUnits, ethers } from './util.mjs';
import { batch } from './rpc.mjs';
import { parseTransfers, NATIVE, simulateBundle } from './evm.mjs';
export function staticRisks({ fp, sigmap, reads, verified }) {
  const R = [];
  const names = Object.values(sigmap).map((x) => x.name || '');
  const has = (re) => names.filter((n) => re.test(n));
  if (fp.impl && fp.proxyType === 'EIP-1167') R.push({ level: 'info', code: 'minimal-proxy', msg: `EIP-1167 最小代理(克隆，不可升级) → impl ${fp.impl}` });
  else if (fp.impl) R.push({ level: 'high', code: 'upgradeable-proxy', msg: `可升级代理 ${fp.proxyType} → impl ${fp.impl}${fp.admin ? ' admin ' + fp.admin : ''}` });
  if (has(/^(upgradeTo|upgradeToAndCall)$/).length && !fp.impl) R.push({ level: 'med', code: 'uups', msg: '含 upgradeTo（UUPS 可升级）' });
  const owner = reads.owner ?? reads.getOwner ?? reads.admin;
  if (owner !== undefined) R.push({ level: lc(owner) === ZERO ? 'info' : 'info', code: 'owner', msg: lc(owner) === ZERO ? 'owner 已放弃(0x0)' : `owner ${owner}` });
  if (has(/^paused$/).length) R.push({ level: reads.paused === true || reads.paused === 1n ? 'high' : 'info', code: 'pausable', msg: `可暂停 paused=${String(reads.paused)}` });
  const bl = has(/black|blacklist|isBlocked|banned|bot/i); if (bl.length) R.push({ level: 'med', code: 'blacklist', msg: '黑名单函数: ' + bl.slice(0, 4).join(',') });
  const wl = has(/whitelist|allowlist|merkle|^root$|signer|quotaSigner/i); if (wl.length) R.push({ level: 'info', code: 'whitelist/signature', msg: '白名单/签名闸: ' + wl.slice(0, 4).join(',') });
  const setters = has(/^set(Price|MintPrice|Fee|Tax|Fees|MaxSupply|Paused|Signer|Treasury)/i); if (setters.length) R.push({ level: 'med', code: 'owner-setters', msg: 'owner 可改参数: ' + setters.slice(0, 5).join(',') });
  const wd = has(/^(withdraw|rescue|emergencyWithdraw|sweep)/i); if (wd.length) R.push({ level: 'info', code: 'withdraw', msg: 'owner 提款函数: ' + wd.slice(0, 3).join(',') });
  if (verified === false) R.push({ level: 'med', code: 'unverified', msg: '源码未在 sourcify 验证（bscscan 需 key 未查）' });
  return R;
}
/** analyse simulated logs for one wallet */
export function simRisks({ wallet, logs, mint, payToken, valueWei, expectedPay, knownSafe = [] }) {
  const R = [];
  const tr = parseTransfers(logs);
  const w = lc(wallet);
  const safe = new Set([lc(mint), ...knownSafe.map(lc)]);
  const outflows = tr.filter((t) => (t.kind === 'erc20' || t.kind === 'native') && lc(t.from) === w);
  const inflows = tr.filter((t) => (t.kind !== 'approval') && lc(t.to) === w && lc(t.from) !== w);
  const approvals = tr.filter((t) => t.kind === 'approval' && lc(t.owner) === w);
  for (const a of approvals) R.push({ level: 'high', code: 'approval-in-mint', msg: `mint 过程中产生了 ${KNOWN[lc(a.token)] || a.token} 授权 → ${a.spender} amt=${a.amount}` });
  for (const o of outflows) {
    const tokName = o.kind === 'native' ? 'BNB' : KNOWN[lc(o.token)] || o.token;
    if (o.kind === 'erc20' && (payToken === 'BNB' || lc(o.token) !== lc(payToken))) R.push({ level: 'high', code: 'unexpected-token-pull', msg: `转出非支付币 ${tokName} ${o.amount}` });
    if (o.kind === 'erc20' && expectedPay && o.amount > (expectedPay * 105n) / 100n) R.push({ level: 'high', code: 'overpull', msg: `转出 ${tokName} ${fmtUnits(o.amount)} > 预期 ${fmtUnits(expectedPay)}` });
    if (o.kind === 'erc20' && !safe.has(lc(o.to))) R.push({ level: 'med', code: 'pay-to-other', msg: `${tokName} ${fmtUnits(o.amount)} 直接转给 ${o.to}（非 mint 合约）` });
  }
  // what the wallet received
  const got = inflows.map((t) => ({ token: t.token, kind: t.kind, amount: t.amount, id: t.id }));
  // minted asset to someone else?
  const minted = tr.filter((t) => (t.kind === 'erc20' || t.kind === 'erc721') && lc(t.from) === ZERO);
  const mintedElsewhere = minted.filter((t) => lc(t.to) !== w && !safe.has(lc(t.to)));
  const nativeOut = tr.filter((t) => t.kind === 'native' && lc(t.from) === lc(mint) && !safe.has(lc(t.to)) && lc(t.to) !== w);
  const recipients = [...new Set(nativeOut.map((t) => t.to))];
  return { risks: R, got, outflows, mintedToSelf: minted.some((t) => lc(t.to) === w) || got.length > 0, mintedElsewhere, nativeRecipients: recipients };
}
/** Pair + buy/sell tax via eth_simulateV1 (buy with 0.01 BNB, then sell all). */
export async function tokenTax(token, sim = true) {
  if (!token) return null;
  const out = { token };
  const [p1, p2] = await batch([
    { method: 'eth_call', params: [{ to: FACTORY, data: '0xe6a43905' + encAddr(token) + encAddr(WBNB) }, 'latest'] },
    { method: 'eth_call', params: [{ to: FACTORY, data: '0xe6a43905' + encAddr(token) + encAddr(USDT) }, 'latest'] },
  ]);
  const pairW = p1.result && p1.result.length >= 66 ? '0x' + p1.result.slice(26, 66) : ZERO;
  const pairU = p2.result && p2.result.length >= 66 ? '0x' + p2.result.slice(26, 66) : ZERO;
  out.pairWBNB = lc(pairW) === ZERO ? null : ethers.getAddress(pairW);
  out.pairUSDT = lc(pairU) === ZERO ? null : ethers.getAddress(pairU);
  const pair = out.pairWBNB || out.pairUSDT;
  if (!pair) { out.status = '未开池(Pancake V2 无 pair)'; return out; }
  const [rv] = await batch([{ method: 'eth_call', params: [{ to: pair, data: '0x0902f1ac' }, 'latest'] }]);
  if (rv.result && rv.result.length >= 130) { out.reserve0 = BigInt(rv.result.slice(0, 66)); out.reserve1 = BigInt('0x' + rv.result.slice(66, 130)); }
  if (!out.reserve0 || !out.reserve1) { out.status = 'pair 已建但无流动性'; return out; }
  if (!sim) return out;
  const path = out.pairWBNB ? [WBNB, token] : [WBNB, USDT, token];
  const W = '0x000000000000000000000000000000000000bEEF';
  const inBnb = 10n ** 16n;
  const dl = BigInt(Math.floor(Date.now() / 1000) + 600);
  const iface = new ethers.Interface(['function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable', 'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)', 'function getAmountsOut(uint256,address[]) view returns (uint256[])', 'function approve(address,uint256)', 'function balanceOf(address) view returns (uint256)']);
  const ov = { [W]: { balance: '0x' + (10n ** 18n).toString(16) } };
  const b1 = await simulateBundle([
    { from: W, to: ROUTER, data: iface.encodeFunctionData('getAmountsOut', [inBnb, path]) },
    { from: W, to: ROUTER, value: inBnb, data: iface.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [0, path, W, dl]) },
    { from: W, to: token, data: iface.encodeFunctionData('balanceOf', [W]) },
  ], ov);
  if (b1.error || !b1.calls?.[1]) { out.status = 'sim 失败 ' + (b1.error || ''); return out; }
  const q = b1.calls[0].ok ? iface.decodeFunctionResult('getAmountsOut', b1.calls[0].ret)[0] : null;
  if (!b1.calls[1].ok) { out.status = '买入 sim revert: ' + b1.calls[1].err; out.honeypot = 'buy-blocked'; return out; }
  const got = BigInt(b1.calls[2].ret.slice(0, 66));
  const expTok = q ? q[q.length - 1] : 0n;
  out.buyTaxPct = expTok ? Number(((expTok - got) * 10000n) / expTok) / 100 : null;
  const spath = [...path].reverse();
  const b2 = await simulateBundle([
    { from: W, to: ROUTER, value: inBnb, data: iface.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [0, path, W, dl]) },
    { from: W, to: token, data: iface.encodeFunctionData('approve', [ROUTER, got]) },
    { from: W, to: ROUTER, data: iface.encodeFunctionData('getAmountsOut', [got, spath]) },
    { from: W, to: ROUTER, data: iface.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', [got, 0, spath, W, dl]) },
  ], ov);
  if (b2.error || !b2.calls?.[3]) { out.status = '卖出 sim 失败 ' + (b2.error || ''); return out; }
  if (!b2.calls[3].ok) { out.status = '卖出 sim revert: ' + b2.calls[3].err; out.honeypot = 'sell-blocked'; return out; }
  const sq = b2.calls[2].ok ? iface.decodeFunctionResult('getAmountsOut', b2.calls[2].ret)[0] : null;
  const recvd = parseTransfers(b2.calls[3].logs).filter((t) => t.kind === 'native' && lc(t.to) === lc(W)).reduce((a, t) => a + t.amount, 0n);
  const expB = sq ? sq[sq.length - 1] : 0n;
  out.sellTaxPct = expB && recvd ? Number(((expB - recvd) * 10000n) / expB) / 100 : null;
  out.roundTripPct = recvd ? Number(((inBnb - recvd) * 10000n) / inBnb) / 100 : null;
  out.status = 'ok';
  if (out.sellTaxPct !== null && out.sellTaxPct > 15) out.honeypot = 'high-sell-tax';
  return out;
}
