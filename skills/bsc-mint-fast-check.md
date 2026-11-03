---
name: BSC mint fast-check
description: >-
  Use when the user sends a BNB Chain mint/launchpad link or contract to price,
  progress-check, eth_call-simulate, or multi-wallet fill quickly — including
  free mints, invite trains, parallel paid fills, and Mars-like claimReferral.
---
# BSC mint fast-check

## Goal
Any launchpad URL/contract → unit price, progress, 4-wallet total, eth_call sim in seconds. Paid → wait 「打」. Free (`value` 0) → mint ASAP. **All fills: 4 wallets parallel.**

## Speed law (all sites)
1. First tool: `node /workspace/mint-fast/check.mjs <url> [--shares=10]` (≤8s).
2. On 「打/打满/直接」: **immediately** `EXECUTE=1 bash /workspace/mint-fast/parallel-mint.sh` or `fast-fill.sh` with check’s `mint` + `mintData` + `valueWei` — **no second balance scan, no ABI rabbit hole, no site-specific waiting.**
3. If BNB short for paid value: swap USDT→BNB **in the same parallel wallet jobs** (approve+swap then mint), not a separate slow round.
4. Free/`claimFree`: broadcast the second sim OK is known; don’t re-verify freeClaimed first.
5. Report elapsed seconds from the user’s message.

## Fast check
- RPCs: bsc-dataseed*.bnbchain.org → drpc → 1rpc. Skip publicnode first.
- Discovery: `/deployment.json`, `/config/*-mint.json`, `/chain/config.json`, `/config.js`, `/app.js`, `/llms.txt`. Prefer `mintContractAddress`/`launchpad` over `tokenAddress`.
- Report pay token (FREE/BNB/USDT/…) and whether wallets hold enough.
- **首报必须写清：有无邀请/额度加成、支付币、四号余额是否够。**

## Free-phase
`claimFree` / `freeMinted` < freeCap → report FREE, sim+fill `0xf366afc9`. Never treat `costOf` as BNB in free phase. After freeCap, USDT `costOf` → exact approve + mint; BNB only if `mintWithBnb`/basePriceWei says so.

## Paid fill
Exact approve (no MaxUint). Isolate `HOME=/tmp/bawhome-wN`. Near sellout: max no-invite fill first.

## Invite train（写死）
有邀请机制的打新：**必须开火车打满**，禁止只打基础份、禁止单向车丢车尾。

**目标图（用户原话）：**
- 1 拉 2/3/4
- 2 拉 1/3/4
- 3 拉 1/2/4
- 4 拉 1/2/3

**落地（合约每人仅第一次付费可绑一个邀请人时）：**
1. 闭环顺序写死：`W2←W1`、`W3←W2`、`W4←W3`、`W1←W4`。
2. **种子号第一次付费就必须绑车尾**（W1 首笔用 W4 id）。禁止种子 `ref=0` 导致车尾 bonus=0、额度少 1。
3. 实操顺序：先让车尾（W4）付费至少 1 份拿到可被绑身份 → 立刻 W1←W4 首笔 → 再 W2←W1、W3←W2、W4 补绑/补打（若 W4 首笔已用零地址则无法再改绑，只能靠被别人绑来拿 bonus）。
4. 合约若支持多次/多边邀请绑定，按目标图全互拉，不降级成单链。
5. 脚本：`/workspace/mint-fast/invite-train.mjs` + `baw-train.sh`；付费火车与基础份同波开，不拆第二波。

## Parallel
`EXECUTE=1 bash /workspace/mint-fast/parallel-mint.sh <to> <data> [valueWei]`
`EXECUTE=1 bash /workspace/mint-fast/fast-fill.sh <to> <data> [valueWei]` (+ optional APPROVE_*/SWAP_*)

## Mars claimReferral
用户说「领」：`EXECUTE=1 node /workspace/mint-fast/mars-claim.cjs`（fee ~8× gasPrice，且 ≤maxRandomnessFee，再 ×1.2 作 cap）。

## Red lines
No unlimited USDT approve; no unknown transfers. Paid needs 「打/冲/打满」. Always report elapsed s.
