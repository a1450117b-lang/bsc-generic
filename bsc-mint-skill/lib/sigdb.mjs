// Selector <-> signature DB: builtin list + local cache + openchain/4byte lookups.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ROOT, sel, fetchText, withTimeout } from './util.mjs';
const CACHE = ROOT + '/cache/sigs.json';
export const BUILTIN_FUNCS = `
mint() mint(uint256) mint(address) mint(address,uint256) mint(uint256,address) mint(uint256,address,uint256) mint(uint256,address,uint256,uint256)
mint(uint256,bytes32[]) mint(bytes32[]) mint(uint256,bytes) mint((uint64,uint64,uint256,bytes32[])[],uint256) mintTo(address) mintTo(address,uint256)
publicMint(uint256) publicMint() whitelistMint(uint256,bytes32[]) allowlistMint(uint256,bytes32[]) presaleMint(uint256,bytes32[]) safeMint(address) safeMint(address,uint256)
mintWithBnb(uint256,address,uint256) mintWithBnb(uint256,bytes32,uint256) mintWithBnb(uint256,address,uint256,address,uint256) mintWithBNB(uint256) mintWithUsdt(uint256) mintWithUSDT(uint256)
mintWithInviter(uint256,uint256,uint256,uint256,uint256,uint256) mintPaid(uint256,address,uint256) mintFree() claimFree() claim() claim(uint256) claim(address) claim(uint256,bytes32[]) claimReferral(uint256)
buy(uint256) buy() buyTokens(address) purchase(uint256) participate() participate(uint256) contribute() deposit() deposit(uint256) draw(address) reveal(uint256) revealMany(uint256[]) adopt(uint256) forage(uint256[],uint256[])
quote(uint256) priceOf(uint256) costOf(uint256) getPrice(uint256) getMintPrice(uint256) price() mintPrice() MINT_PRICE() PRICE() cost() basePrice() basePriceWei() unitPrice() pricePerShare() publicPrice() salePrice() currentPrice() getPrice() nextPrice() FEE() fee() mintFee() TICKET_FEE()
totalSupply() maxSupply() MAX_SUPPLY() minted() totalMinted() remaining() cap() maxPerWallet() MAX_PER_WALLET() maxPerTx() MAX_PER_TX() maxMintPerTx() maxUnitsPerWallet() totalShares() sharesSold() totalSold() soldCount() mintedShares() freeCap() FREE_CAP() freeMinted() OPEN_AT() openAt() openThreshold() OPENING_TICKET() successfulClaims() MAX_TICKETS() MAX_CANDIDATES() nextId() nextTokenId() totalUnits() unitsSold()
mintedBy(address) numberMinted(address) minted(address) mintedOf(address) mintCount(address) quotaOf(address) quota(address) extraQuota(address) remainingOf(address) walletStatus(address) paidOnce(address) freeClaimed(address) claimed(address) hasMinted(address) canMint(address) mintedCount(address) inviteCount(address) referrerOf(address) inviterOf(address) agentOf(address) bound(address)
paused() saleActive() isOpen() open() opened() mintOpen() mintActive() publicSaleActive() saleOpen() isActive() started() ended() startTime() endTime() startAt() endAt() launchAt() deadline() phase() stage() state() status() saleStart() saleEnd() mintStart() isSaleActive() mintEnabled() tradingEnabled() marketOpen()
owner() admin() getOwner() pendingOwner() implementation() proxiableUUID() upgradeTo(address) upgradeToAndCall(address,bytes) transferOwnership(address) renounceOwnership() pause() unpause() withdraw() withdraw(address) rescue(address,uint256) emergencyWithdraw()
token() usdt() USDT() paymentToken() payToken() currency() quoteToken() nativePayment() rewardToken() nft() pair() router() treasury() feeRecipient() eligibility() idCollection() agentRegistry() agentId() AGENT_ID() registry() signer() merkleRoot() root() referral() inviter()
name() symbol() decimals() balanceOf(address) allowance(address,address) approve(address,uint256) transfer(address,uint256) transferFrom(address,address,uint256) ownerOf(uint256) tokenURI(uint256) setApprovalForAll(address,bool) isApprovedForAll(address,address) supportsInterface(bytes4)
token0() token1() getReserves() factory() WETH() getAmountsOut(uint256,address[]) getPair(address,address)
setPrice(uint256) setMintPrice(uint256) setMaxSupply(uint256) setPaused(bool) setBlacklist(address,bool) blacklist(address) isBlacklisted(address) blacklisted(address) setWhitelist(address[],bool) whitelist(address) isWhitelisted(address) setMerkleRoot(bytes32) setSigner(address) setFee(uint256) setTax(uint256,uint256) setFees(uint256,uint256) excludeFromFee(address) buyTax() sellTax() _taxFee() taxFee() buyFee() sellFee() maxTxAmount() _maxTxAmount() maxWallet() isExcludedFromFee(address)
isClaimed(uint256) verify(uint64,uint64,uint256,bytes32[]) nextBatchId() deploymentSealed() openingPriceRaw() MAINNET_TEST() POLICY_HASH() totalUsdtFeesRaw()
previewFlip(address) previewMint(address) previewMint(address,uint256)
`.trim().split(/\s+/);
export const BUILTIN_ERRORS = `
Error(string) Panic(uint256) EnforcedPause() ExpectedPause() OwnableUnauthorizedAccount(address) OwnableInvalidOwner(address) ReentrancyGuardReentrantCall()
ERC20InsufficientAllowance(address,uint256,uint256) ERC20InsufficientBalance(address,uint256,uint256) ERC721NonexistentToken(uint256) SafeERC20FailedOperation(address)
NothingClaimed() IneligibleHeight() InvalidProof() SwapOutOfBounds() NotEligible() NotAgent() NoAgentId() NotBound() StaleQuote() SoldOut() Closed() NotOpen() AlreadyOpened() MintClosed() ExceedsQuota() QuotaExceeded() OverQuota() InsufficientPayment() WrongValue() InvalidValue() Expired() InvalidReferrer() SelfReferral() MaxPerWallet() MaxPerTx() ZeroAmount() InvalidAmount() Paused() NotStarted() Ended() AlreadyClaimed() InvalidSignature() FailedInnerCall() AddressInsufficientBalance(address) InsufficientBalance() TooMany() SHARES() NotPending()
`.trim().split(/\s+/);
let cache = null;
function load() {
  if (cache) return cache;
  cache = {};
  try { if (existsSync(CACHE)) cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch {}
  for (const s of [...BUILTIN_FUNCS, ...BUILTIN_ERRORS]) { const k = sel(s); (cache[k] ||= []); if (!cache[k].includes(s)) cache[k].unshift(s); }
  return cache;
}
export function save() { if (cache) try { writeFileSync(CACHE, JSON.stringify(cache)); } catch {} }
export function addSigs(sigs) { load(); for (const s of sigs) { try { const k = sel(s); (cache[k] ||= []); if (!cache[k].includes(s)) cache[k].unshift(s); } catch {} } }
export function names(selector) { return load()[selector.toLowerCase()] || null; }
export function name1(selector) { const n = names(selector); return n ? n[0] : null; }
/** Resolve unknown selectors via openchain (batch) then 4byte; caches negative results as []. */
export async function resolve(selectors, { timeoutMs = 3500 } = {}) {
  load();
  const unknown = [...new Set(selectors.map((s) => s.toLowerCase()))].filter((s) => !(s in cache));
  if (!unknown.length) return { looked: 0 };
  const found = {};
  const chunks = [];
  for (let i = 0; i < unknown.length; i += 60) chunks.push(unknown.slice(i, i + 60));
  await withTimeout(Promise.all(chunks.map(async (ch) => {
    const r = await fetchText(`https://api.openchain.xyz/signature-database/v1/lookup?function=${ch.join(',')}&filter=true`, timeoutMs);
    if (!r.ok) return;
    try {
      const j = JSON.parse(r.text);
      for (const [k, arr] of Object.entries(j.result?.function || {})) if (arr && arr.length) found[k] = arr.map((x) => x.name);
    } catch {}
  })), timeoutMs + 300);
  const still = unknown.filter((s) => !found[s]).slice(0, 12);
  await withTimeout(Promise.all(still.map(async (s) => {
    const r = await fetchText(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${s}`, timeoutMs);
    if (!r.ok) return;
    try { const j = JSON.parse(r.text); if (j.results?.length) found[s] = j.results.sort((a, b) => a.id - b.id).map((x) => x.text_signature); } catch {}
  })), timeoutMs + 300);
  for (const s of unknown) cache[s] = found[s] || (cache[s] ?? []);
  save();
  return { looked: unknown.length, found: Object.keys(found).length };
}
