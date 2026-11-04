// Seed history from /workspace/progress-*.md + mint-fast/pool-watch configs (reconstructed 2026-11-04).
import * as H from '../lib/history.mjs';
import { fpRecord } from '../history.mjs';
import { lc } from '../lib/util.mjs';
const P = [
  { name: 'bbforge BBF Core', url: 'https://bbforge.si/', mintContract: '0x95115e644C87DF8Ba170393DE232402c60005FE4', token: '0x6fdE01375Dee314C56193e177512767f88545232',
    mintSig: 'mint((uint64,uint64,uint256,bytes32[])[],uint256)', mintSelector: '0xaa1e883d', calldataTemplate: { mode: 'project-cli', template: 'bbforge Core (Merkle tickets)', notes: ['candidates[] from `bbf-mint-cli prepare --from <addr> --blocks <heights> --tickets 30` (Merkle proofs from /snapshots/)', 'maxTickets≤30, 36 candidates/tx'] },
    price: { unitWei: '10000000000000000', payToken: 'USDT', source: 'USDT_FEE_PER_TICKET_RAW()' }, inviteMechanism: 'none', approveRequired: 'exact USDT per batch (0.3 USDT/30 tickets); never MaxUint', gasUsed: 1190000,
    discovery: { sourcePaths: ['/data/deployment.json', '/api/status', '/llms.txt'] }, outcome: 'success', srcFiles: ['progress-bbforge-sim.md', 'progress-bbforge-mint.md'],
    lessons: ['需持 Agent ID (SPACE ID 0x60B9…022F)', 'USDT 0.01/ticket, value=0, exact approve', '高燃烧区块(top pages)被秒抢 → NothingClaimed，改用 /api/blocks 中段 page (n*1000+) 各号不同 page', '开盘后 mint 约 2315 BBF/ticket vs 开盘前 6218 → open 后收益大降', 'blastapi RPC 返回 missing revert data → 用 defibit/dataseed', 'NothingClaimed=候选已被占，不扣费'] },
  { name: 'BNBCAT Genesis', url: null, mintContract: '0x7FcD981A1E48b3fB488C2E21D987156b2A4df48a', token: '0x8CAfc39863386538B04172B268Bdd38E9f626E94',
    mintSig: 'mintGen0(uint256)', mintSelector: '0x32bef484', price: { payToken: 'BNB', source: 'quoteGen0(n)' }, inviteMechanism: 'unknown', approveRequired: 'none', outcome: 'success', srcFiles: ['progress-bnbeat-*.md'],
    lessons: ['游戏合约: Animals NFT 0x2bBB…82Db + CHEESE token 0x8CAf…6E94', 'forage(uint256[] mouseIds,uint256[] catIds) 0x9a0d1e30 value 0，无需 approve（游戏合约特权）', '每鼠 20% 被抓概率(鼠烧毁)；觅食结算时存活鼠拿 80%', '只能由 NFT 持有号签 forage'] },
  { name: 'SAFUAI', url: 'https://safuai.fun/', mintContract: '0xbD6087fC30F2395344020CB190255C56CBC517bd', token: '0x2b96fc99cb3edc8e3a907b63d19a06db5ad894ab',
    mintSig: 'mintWithBnb(uint256,address,uint256,address,uint256)', mintSelector: '0x547c1db9', calldataTemplate: { mode: 'template', template: 'sufa/agent-launch', notes: ['(units, ref, maxCost=value, token, minTokensOut)'] },
    price: { unitWei: '2000000000000000', payToken: 'BNB', source: 'quote(n)' }, inviteMechanism: 'ref 首次付费 mint → 邀请人 +1 额度 (extraQuota)；闭环火车 W4←W3,W1←W4,W2←W1,W3←W2', approveRequired: 'none', gasUsed: 310000, outcome: 'success', srcFiles: ['progress-safuai-*.md'],
    lessons: ['站点 HTML mint:0xe38fd349 已过时，以近期成功 tx selector 0x547c1db9 为准', 'value +2% buffer 多余同笔退回', '基础 10/Agent ID + 邀请 +1 = 11', 'BNB 不足时先 USDT→BNB'] },
  { name: 'GrokAgent', url: 'https://grokagent.fun', mintContract: '0x668ad1eac6045ebe72ad2715fc2a4226c682fd4b', token: '0x59C34b8F07Aa50bd469f33C30DdB66518D0b670D', mintSig: 'mintWithBnb(uint256,address,uint256,address,uint256)', mintSelector: '0x547c1db9',
    price: { unitWei: '2000000000000000', payToken: 'BNB', source: 'quote(n)' }, inviteMechanism: 'ref +1 (同 SAFUAI)', approveRequired: 'none', outcome: 'success', srcFiles: ['progress-grokagent*.md'], lessons: ['同族 SAFUAI/屎币Agent；每号 11 份 = 550M GROK'] },
  { name: '屎币Agent shibiagent', url: 'https://shibiagent.fun/', mintContract: '0x4d169ef8e1617070cfe5f8f7afbee56a301e0f8a', token: '0x5d1c2cccd553e0d6665c1976928decd739dc95c4', mintSig: 'mintWithBnb(uint256,address,uint256,address,uint256)', mintSelector: '0x547c1db9',
    price: { unitWei: '2000000000000000', payToken: 'BNB', source: 'BASE_PRICE_WEI/quote' }, inviteMechanism: 'extraQuota ref +1', approveRequired: 'none', outcome: 'success', srcFiles: ['progress-shibiagent-*.md'], lessons: ['config 无地址 → HTML bootstrap + 成功块扫描 selector 找到 mint', 'app.js mint:0xe38fd349 过时'] },
  { name: '币安狗 binanciansai', url: 'https://binanciansai.meme/project/0x0733bcf81eb7890b91e29938503d154a051c5144', mintContract: '0x0733bcf81eb7890b91e29938503d154a051c5144', token: '0x467e49A5CD2F73F463628E2016aB658e4979089D',
    mintSig: 'mint(uint256,address,uint256,uint256)', mintSelector: '0xbf2c8a94', price: { unitWei: '3000000000000000', payToken: 'BNB', source: 'costOf(n)' }, inviteMechanism: 'ref 首次付费 +1 (extraQuota)', approveRequired: 'none', outcome: 'success', srcFiles: ['progress-binanciansai-*.md'],
    lessons: ['check.mjs 未命中 → /api/config + /api/projects/<mint>', 'value=costOf*1.02, minTokens=tokensOut*0.99', 'MAX_PER_TX=10 (costOf(11) revert SHARES)'] },
  { name: 'burnagent', url: 'https://burnagent.fun/', mintContract: '0x7De1606230AA70802caeCF1A3e90039A6265B1c4', mintSig: 'mintWithInviter(uint256,uint256,uint256,uint256,uint256,uint256)', price: { unitWei: '2000000000000000', payToken: 'BNB' },
    inviteMechanism: 'mintWithInviter(id,qty,expectedStart,minTokens,deadline,inviterId)；被邀首次付费 +1', approveRequired: 'none', outcome: 'partial', failureReason: 'W3 单线程低频未打上 (0/11)；StaleQuote: expectedStart 须=totalMinted+1 且链上在涨', srcFiles: ['progress-burnagent-*.md'],
    lessons: ['agentId=keccak(handle) 钱包专属参数', 'expectedStart 过期 → StaleQuote，实打前重编', 'freeMinted 300/300 满后 claimFree 全 revert'] },
  { name: 'Build N Build', url: 'https://buildnbuild.xyz/#mint', mintContract: '0xf93e893003bB8feD50F19Ce0d9589AeDf36D5b2c', token: '0x460610467e2EF0ea96642AE379764D268081D8DD', mintSig: 'mint(uint256)', mintSelector: '0xa0712d68',
    price: { unitWei: '2000000000000000', payToken: 'BNB', source: 'quote(n)' }, inviteMechanism: '有文案但不加额度', approveRequired: 'none', outcome: 'success', srcFiles: ['progress-buildnbuild-*.md'], lessons: ['每 Agent 地址上限 10 份', '邀请不增加 cap，不开火车'] },
  { name: 'KDA.life KDAMint', url: 'https://kda.life/', mintContract: '0xde454bD5e1dfE7CF2B6c795213e621FD4f79bA02', token: '0xa62E2c204A549671339dD3FafA9C8dC74b06a260', mintSig: 'mint(uint256)', mintSelector: '0xa0712d68',
    price: { unitWei: '1650000000000000', payToken: 'BNB', source: 'phase price' }, inviteMechanism: 'draw(referrer) 绑邀请；被邀首次付费 inviteBonus+1 (MAX_INVITE_BONUS=3)', approveRequired: 'none', outcome: 'sim-only', srcFiles: ['progress-kda-*.md'],
    lessons: ['须先 draw → reveal 才能 mint，否则 NotBound', '未售罄可退 90%'] },
  { name: 'Fireball Agent', url: 'https://fb.fireball.here.now/', mintContract: '0xB594b29360BD45975608C92dBDBA764c508B5c99', token: '0xb6f7E8990E9f7eB247E08480fd9657D4D496a122', mintSig: 'mintWithBnb(uint256,address,uint256)', mintSelector: '0xe38fd349',
    price: { unitWei: '2000000000000000', payToken: 'BNB' }, inviteMechanism: 'none(免费轮 claimFree)', approveRequired: 'none', outcome: 'success', srcFiles: ['progress-fireball*.md'],
    lessons: ['js/config.js?v=... 有 mint/token/pair', 'paused 时 claimFree revert EnforcedPause (0x9e87fac8)', 'FREE_CAP 1000 每号 1 → 之后 BNB 付费 0.002'] },
  { name: 'RushAI L2Launch', url: 'https://rushai.bid/#buy', mintContract: '0x87f7B4cfb748B7595B7d93504aB799f0e7abcbb4', price: { payToken: 'BNB' }, outcome: 'success', srcFiles: ['progress-rushai*.md'], lessons: ['购买后需 reveal(commitBlock+5 后 256 块内)', '价格随份号浮动 ≈0.0016 BNB'] },
  { name: 'agentcoinflip Game', url: 'https://agentcoinflip.xyz/', mintContract: '0xFFEa9BB9FA6607a065C670705907600FD31f6ABF', mintSig: 'claim()', mintSelector: '0x4e71d92d', price: { payToken: 'FREE/BNB' }, outcome: 'success', srcFiles: ['progress-agentcoinflip.md'],
    lessons: ['previewFlip(addr) kind0=FREE 1/2=PAID 3=SOLD_OUT 4=NO_AGENT', 'claim() value 必须 == priceWei', 'llms.txt 有合约地址'] },
  { name: '屎壳郎Agent dungbeetle', url: null, mintContract: '0x03c21ed8ffe01fe23d8868dd1e8f95c359e022b9', token: '0x3d1adf72e6efb1c1733ddee72b8df002a0838e80', price: { payToken: 'BNB' }, inviteMechanism: 'ref +1 火车', outcome: 'success', srcFiles: ['progress/progress-dungbeetle-mint.md'],
    lessons: ['mint 0.0877 BNB → 卖出仅 0.0474 BNB（亏 46%）', 'BAW market 卖失败 → Pancake router 兜底'] },
  { name: 'AIPRO', url: null, mintContract: '0xf87c287dfba01abfee812f5b4ed37cb9028ef424', token: '0x577bEa203E5326Ff6E1d4594A94167111836b286', price: { unitWei: '4000000000000000', payToken: 'BNB' }, outcome: 'success', srcFiles: ['pool-watch/examples/aipro'], lessons: ['10*0.004=0.04 BNB → 500M；+1 share 邀请'] },
  { name: 'BNBH bnbholderai', url: 'https://bnbholderai.meme/', mintContract: '0x3651f7A305Bf37ee4c5BE03f38dE41554Bc972da', token: '0xE08dAb5507DF2f65C46641c5FecC6F3514c2b360', price: { payToken: 'BNB' }, outcome: 'success', srcFiles: ['pool-watch/examples/bnbh'], lessons: ['0.02 BNB/号'] },
];
const existing = H.loadAll();
const out = await Promise.all(P.map(async (p) => {
  try { const f = await fpRecord(p.mintContract); return { ...p, ...f }; } catch (e) { return { ...p, fpError: e.message }; }
}));
for (const r of out) {
  const ex = existing.find((x) => lc(x.mintContract) === lc(r.mintContract));
  const s = H.upsert({ ...r, id: ex?.id, seeded: true });
  console.log(s.id.padEnd(36), s.outcome.padEnd(9), (s.fingerprint?.selectors?.length ?? 'ERR ' + r.fpError) + ' sel', s.proxyImpl || '');
}
