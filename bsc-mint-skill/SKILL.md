---
name: bsc-mint-precheck
description: >-
  Use FIRST whenever the user sends a BNB Chain (BSC, chainId 56) mint / launchpad / presale
  URL or a contract address (CA), or asks "能不能打 / 多少钱 / 还剩多少 / 开了没". Runs a read-only
  pre-check (contract + mint function + price + pay token + 4-wallet eligibility sims + quota +
  open status + risk + history match) and returns a Chinese report for the user to confirm.
  Never signs, approves, pays or broadcasts.
---
# BSC Mint 预检 (read-only)

Toolkit: `/workspace/bsc-mint-skill/` (Node 22, ethers v6 local). History: `history/projects.jsonl`.
Runs: `runs/<UTC+8 ts>-<name>.json`. AI bundles: `bundles/`.

## 1. Run (always first, before any manual research)
```
node /workspace/bsc-mint-skill/precheck.mjs <url-or-CA> [--shares N] [--json] [--no-history-write]
```
- `--shares N` planned shares per wallet (default 10; auto-clamped to MAX_PER_TX-style getters).
- `--json` machine output (same fields as the run file). `--cold` ignores history (benchmark only).
- Typical: 3–7 s with a history match, 6–12 s cold. Report the 耗时 line to the user.

## 2. Read the report
- **合约/函数**: chosen mint contract (ranked from site config keys + bytecode selectors; pair/token demoted) and
  mint fn + selector + calldata mode: `template:*` (known family) > `recent-tx-replay` (a real recent tx to the
  contract with our address substituted) > `generic-builder` (types/ABI names; check `注:`).
- **单价**: unit + pay token + where it came from (getter name / site text / history). `history(未实时核对!)` = must verify by hand.
- **进度/开放**: sold/cap getters, paused/opened/start/end flags, site `/api/status`. `已售罄` / `mint 大概率已结束` / `额度已用完` are inferred.
- **表 号｜资格｜sim｜BNB｜USDT｜够?**
  - 资格 = eth_simulateV1 with BNB (+pay-token balance/allowance) overridden → pure eligibility. `OK*` = reached the
    project's expected revert (e.g. bbforge `NothingClaimed`: gates passed, project args must be regenerated).
  - sim = eth_estimateGas on REAL state → would it go through right now (balance / approve missing shows here).
  - `[pensLeftOf=…, mintedBy=…]` per-wallet quota getters. `AgentID=` SPACE ID balance when gated.
- **风险**: 🔴 high / 🟠 med. Upgradeable proxy (EIP-1967/1822/Beacon; EIP-1167 clones are NOT upgradeable),
  owner setters, pausable, black/whitelist, approval/extra-token pulls/other recipients seen in simulated logs,
  mint-to-other, value too high, price changed vs history, token buy/sell tax (simulated round trip via Pancake).
- **⚠️异常** lines must be shown to the user verbatim.
- **历史匹配**: exact-bytecode > normalized-bytecode > same-impl > selector Jaccard ≥0.6. A match reuses the
  recognition method (mint selector, getters, discovery paths, lessons) but address / price / args are always re-read live.

## 3. When to do AI analysis (`needs_ai_analysis: true`)
Triggered when: no mint fn found, low-confidence args without history, or all sims fail with unexplained errors.
Read only the bundle file printed (`bundles/*.json`, ~5–15 KB: resolved selectors, error selectors, reads,
recent txs, sim errors, site hints, sourcify status). Work out the mint fn/args/value, then re-run precheck or
build the calldata by hand and eth_call it. Do NOT re-crawl the whole site or decompile unless the bundle is insufficient.
Also check the matched history `lessons` first – they often explain the revert (NotBound → draw first, StaleQuote → refresh expectedStart, …).

## 4. Record outcome (after the user decides / after execution)
```
node history.mjs update-outcome <id|addr|name> success|fail|cancelled|partial [--reason ".."] [--lesson ".."] [--gas N] [--tx 0x..] [--cost ".."]
node history.mjs add --ca 0x.. --name X --url .. [--outcome ..] [--lesson ..]     # manual add (auto fingerprint)
node history.mjs list | show <q> | match <CA> | compact
```
Every precheck run auto-upserts a `sim-only` record (fingerprint, selector set + names, mint fn, price, discovery
paths, timings) unless `--no-history-write`. Always add a lesson when something surprised you.

## 5. Red lines
- Default is READ-ONLY: precheck only uses eth_call / eth_simulateV1 / eth_estimateGas / getCode / getStorageAt / logs / HTTP GET.
  Its RPC client refuses any send method.
- Paid execution only after the user explicitly says 「打 / 冲 / 打满」 for this project; re-run precheck right before
  executing (prices, quotas, Merkle candidates and expectedStart go stale in seconds–minutes).
- Approve = exact amount for this batch, never MaxUint. No approve at all for BNB-paid mints.
- Stop and ask if the simulation shows: approvals, transfers of tokens other than the pay token, payment to an
  address other than the mint contract/known treasury, minted asset going to someone else, upgradeable proxy whose
  admin changed, or sell tax / sell revert on the token. Unknown transfers = stop.
- Execution itself uses the existing tools (`/workspace/mint-fast/parallel-mint.sh`, `fast-fill.sh`, invite-train,
  project CLIs) and the bsc-mint-fast-check skill rules (4 wallets in parallel, invite train closed loop).

## Known limitations
- Price/pay-token inference is heuristic when the contract is unverified (getter names like quote/costOf/priceOf/BASE_PRICE_WEI);
  ambiguous per-serial getters (e.g. `priceForShare(n)`) can be off → check `price.source`, compare site hint.
- Wallet-specific args (agentId = keccak(handle), signatures, Merkle proofs, expectedStart) are not generated;
  the tool falls back to replaying a recent real tx and labels it.
- Recent-tx scan needs a log-capable RPC (publicnode/drpc; bsc-dataseed rejects eth_getLogs); capped at 4.5 s.
- Contract age not reported (public nodes are pruned); verification only via sourcify (no bscscan key).
- Token tax sim only for Pancake V2 pairs (WBNB or USDT).
