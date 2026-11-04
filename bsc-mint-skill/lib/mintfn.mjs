// Mint-function identification + calldata building (templates from history + generic builder).
import { ethers, ZERO, lc } from './util.mjs';
const coder = ethers.AbiCoder.defaultAbiCoder();
export const MINT_RE = /^(mint|publicMint|safeMint|presaleMint|whitelistMint|allowlistMint|claimFree|freeMint|buy|purchase|participate|contribute|adopt|join|subscribe|draw|forge|claim)/i;
export const NOT_MINT_RE = /^(minted|mintedBy|mintedCount|mintedOf|mintCount|mintPrice|mintFee|mintStart|mintEnd|mintOpen|mintActive|mintEnabled|mintedByAsset|mintingFinished|claimed|claimable|claimedBy|purchased|buyTax|buyFee|buyback|buyBack|claimDividends|claimReward|claimRewards|claimTax|claimOwnership|joined|drawn)/i;
/** Known calldata templates (selector → builder). ctx: {shares, self, token, costN, unit, valueWei, maxPay, totalMinted, minTokens} */
export const TEMPLATES = {
  '0x547c1db9': { sig: 'mintWithBnb(uint256,address,uint256,address,uint256)', pay: 'BNB', buffer: 102, family: 'sufa/agent-launch (SAFUAI/GrokAgent/屎币Agent)', args: (c) => [c.shares, ZERO, c.valueWei, c.token || ZERO, 0n], note: 'units, ref, maxCost(=value), token, minTokensOut' },
  '0xe38fd349': { sig: 'mintWithBnb(uint256,address,uint256)', pay: 'BNB', buffer: 102, family: 'Fireball/cats launchpad', args: (c) => [c.shares, ZERO, c.valueWei] },
  '0xbf2c8a94': { sig: 'mint(uint256,address,uint256,uint256)', pay: 'BNB', buffer: 102, family: '币安人 LaunchPad', args: (c) => [c.shares, ZERO, c.valueWei, 0n], note: 'shares, referrer, maxCost, minTokens' },
  '0x94bf804d': { sig: 'mint(uint256,address)', pay: 'BNB', buffer: 100, family: 'GooseMint/sklagent', args: (c) => [c.shares, ZERO] },
  '0x836a1040': { sig: 'mint(uint256,address,uint256)', pay: 'USDT', buffer: 102, family: 'longxia/cats USDT', args: (c) => [c.shares, ZERO, c.maxPay] },
  '0x02163e1f': { sig: 'mintWithBnb(uint256,bytes32,uint256)', pay: 'BNB', buffer: 102, family: 'sensei/fly', args: (c) => [c.shares, ethers.ZeroHash, (c.costN * 98n) / 100n] },
  '0xa0712d68': { sig: 'mint(uint256)', pay: 'BNB', buffer: 100, family: 'plain mint(uint256) (Build N Build / KDA)', args: (c) => [c.shares] },
  '0x1249c58b': { sig: 'mint()', pay: 'BNB', buffer: 100, family: 'plain mint()', args: () => [] },
  '0xf366afc9': { sig: 'claimFree()', pay: 'FREE', buffer: 100, family: 'free-claim phase', args: () => [], free: true },
  '0x4e71d92d': { sig: 'claim()', pay: 'FREE', buffer: 100, family: 'claim()', args: () => [] },
  [ethers.id('mint((uint64,uint64,uint256,bytes32[])[],uint256)').slice(0, 10)]: { sig: 'mint((uint64,uint64,uint256,bytes32[])[],uint256)', pay: 'USDT', buffer: 100, family: 'bbforge Core (Merkle tickets)', args: (c) => [[], c.shares], needsProject: 'candidates[] 需要官方 CLI prepare 生成 Merkle 证明 (bbf-mint-cli)；预检复用近期 tx 的候选(已被占)或空候选 → 期望 NothingClaimed/InvalidBatch', expectRevert: /NothingClaimed/ },
};
export function scoreMintCandidates(sigmap, { recent = {}, siteNames = [], historySel = null } = {}) {
  const out = [];
  for (const [s, info] of Object.entries(sigmap)) {
    const name = info.name;
    if (!name || !MINT_RE.test(name) || NOT_MINT_RE.test(name) || /^[A-Z0-9_]+$/.test(name)) continue;
    if (info.stateMutability === 'view' || info.stateMutability === 'pure') continue;
    let sc = 10;
    if (/^mintWith/i.test(name)) sc = 55; else if (/^(mint|publicMint|mintGen)/i.test(name)) sc = 50; else if (/^(claimFree|freeMint)/i.test(name)) sc = 45;
    else if (/^(buy|purchase|participate|contribute|adopt|subscribe)/i.test(name)) sc = 35; else if (/^(presale|whitelist|allowlist)Mint/i.test(name)) sc = 30;
    else if (/^claim$/i.test(name)) sc = 20; else if (/^claim/i.test(name)) sc = 8; else if (/^(draw|forge|join)/i.test(name)) sc = 12;
    if (TEMPLATES[s]) sc += 30;
    if (recent[s]) sc += 25 + Math.min(20, recent[s] * 3);
    if (historySel && lc(historySel) === s) sc += 40;
    if (siteNames.includes(name)) sc += 5;
    if (/bytes(?!32)/.test(info.sig) && !/bytes32/.test(info.sig)) sc -= 10; // server signature needed
    if (info.stateMutability === 'payable') sc += 5;
    out.push({ selector: s, sig: info.sig, name, score: sc, template: TEMPLATES[s] ? TEMPLATES[s].family : null, inputs: info.inputs });
  }
  return out.sort((a, b) => b.score - a.score);
}
/** Generic arg builder from types (+ optional ABI param names). Returns {args, notes, confidence}. */
export function buildArgs(sig, inputs, c) {
  const frag = ethers.FunctionFragment.from('function ' + sig);
  const notes = [];
  let conf = 'high';
  let uintSeen = 0;
  const fnName = frag.name;
  const args = frag.inputs.map((p, i) => {
    const nm = (inputs?.[i]?.name || '').toLowerCase();
    const t = p.type;
    if (t.endsWith('[]') || p.baseType === 'array') { notes.push(`${nm || 'arg' + i}=[]`); conf = 'low'; return []; }
    if (p.baseType === 'tuple') { conf = 'low'; return p.components.map(() => 0); }
    if (t === 'address') {
      if (/ref|invit|sponsor|upline|promot/.test(nm)) return ZERO;
      if (/^(to|recipient|receiver|account|user|_to|beneficiary)$/.test(nm) || (/To$/.test(fnName) && i === 0)) return c.self;
      if (/token/.test(nm)) return c.token || ZERO;
      if (!nm) notes.push(`arg${i}:address=0`);
      return ZERO;
    }
    if (t.startsWith('uint') || t.startsWith('int')) {
      if (/max|cost|pay|limit/.test(nm)) return c.maxPay ?? c.valueWei ?? 0n;
      if (/min|out|slippage/.test(nm)) return 0n;
      if (/deadline|expir|until|valid/.test(nm)) return BigInt(Math.floor(Date.now() / 1000) + 900);
      if (/expected|start|serial|nonce/.test(nm)) return (c.totalMinted ?? 0n) + 1n;
      if (/agent|id$|tokenid/.test(nm)) { notes.push(`${nm}=?(需要钱包专属ID)`); conf = 'low'; return 0n; }
      uintSeen++;
      if (uintSeen === 1) return c.shares;
      if (!nm) { notes.push(`arg${i}:uint=0(猜测)`); conf = conf === 'high' ? 'medium' : conf; }
      return 0n;
    }
    if (t === 'bool') return false;
    if (t.startsWith('bytes')) { if (t === 'bytes') { notes.push('bytes=0x(可能需要服务端签名)'); conf = 'low'; return '0x'; } return ethers.ZeroHash; }
    if (t === 'string') return '';
    return 0n;
  });
  return { args, notes, confidence: conf };
}
export function encode(sig, args) {
  const frag = ethers.FunctionFragment.from('function ' + sig);
  return frag.selector + coder.encode(frag.inputs, args).slice(2);
}
/** Turn a real recent tx calldata into a template: replace sender address words with {self}. */
export function templFromTx(input, from) {
  const body = input.slice(10);
  const f = lc(from).slice(2).padStart(64, '0');
  const words = [];
  for (let i = 0; i < body.length; i += 64) words.push(body.slice(i, i + 64) === f ? '{self}' : body.slice(i, i + 64));
  return { selector: input.slice(0, 10), words, len: body.length / 2 };
}
export function fillTx(t, self, shares) {
  return t.selector + t.words.map((w) => (w === '{self}' ? lc(self).slice(2).padStart(64, '0') : w)).join('');
}
