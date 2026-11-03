---
name: bsc-sell-fast
description: >-
  Use when the user orders selling/跑本/止损/全卖 a BNB Chain token to USDT across the
  four wallets and speed matters.
---
# BSC 四号快速卖币（→ USDT）

## When
用户说卖/全跑/止损/换成 USDT，且目标是四钱包并行市价卖。速度第一：不要报价拖延、不要问队友要入口。

## Hard rules
- 直接 `baw market-order swap`，四号并行。
- 精确授权；禁止 MaxUint 无限授权。
- 只卖回自己钱包；无限授权或转陌生地址立刻停。
- 用户未当场下令卖则不卖。
- 小币/多池：极快比对报价与池价，差太多先汇报再停（记忆教训）。

## Fast path
1. 确认 token 地址（或从用户链接解析）。
2. 一键跑：
   ```bash
   /workspace/sell-fast/sell-all.sh <token>
   ```
   或指定数量：`/workspace/sell-fast/sell-all.sh <token> <qty>`
   备用路径：`/cursor/stores/store-6b316fcf-4b71-4205-8a24-d84141fa9db3/sell-fast/sell-all.sh`
3. 脚本会：校验 `~/.baw-wallets/w1..w4/session.json`、HOME 隔离、并行市价卖到 USDT（`0x55d3…7955`）、默认 `GAS=HIGH`。
4. 读 `/tmp/baw-sell-wN.log`，立刻向用户汇报每号到手与 hash；不要等齐再报（能报先报）。
5. 链上核对 token 余额是否清零。

## Session warm
开卖前若 session 缺失/失效：先修登录再卖，不要空转。

## Optional env
`MEV=false`（仅用户接受关保护时）、`GAS=HIGH`、`SLIPPAGE=auto`。
