---
name: bsc-pool-watch
description: >-
  Use when the user asks to monitor a BNB Chain mint/token for pool open and
  then 出本/止损/全卖/全转 — apply this generic template instead of rewriting per
  project.
---
# BSC 开池卖币监控（通用模版）

## When
用户说「监控某某开池」「三倍出本」「跌X%全出」「开池后全转某地址」「开池后全卖」等。**不要每个项目重写流程**；套本模版，只填参数。

## 参数（写入 `/workspace/pool-watch/<slug>/config.json`）
- `TOKEN` / `PAIR` / `COST_PER_WALLET`
- `actions`: `tp_principal` | `sl_all` | `sell_all` | `transfer_all`
- `tpMult` / `slPct` / `dest`

## Hard rules
- 「出本」只卖回本金对应数量；「全卖/止损」才清仓。
- 卖走 bsc-sell-fast：`/workspace/sell-fast/sell-all.sh`；禁 MaxUint。
- 转账须核对完整地址。税/损耗>10% 或报价离谱先汇报。
- 用户当场下令的触发条件可自动执行；未授权只监控。

## 流程
1. 填 config → `node /workspace/pool-watch/check.mjs --dir <slug>`
2. 挂 routine；达触发则执行并汇报；无变化安静。
