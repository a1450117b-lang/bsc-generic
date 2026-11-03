# pool-watch 通用模版

1. 复制目录：`mkdir -p /workspace/pool-watch/<slug>`
2. 写 `config.json`（见下）
3. 检查：`node /workspace/pool-watch/check.mjs --dir <slug>`
4. 按技能 [bsc-pool-watch](sand-workflow:bsc-pool-watch) 挂 routine / 执行卖转

## config.json 示例
```json
{
  "token": "0x...",
  "mint": "0x...",
  "pair": "0x...",
  "defaultCostBnb": 0.02,
  "costPerWallet": { "1": 0.02, "2": 0.02, "3": 0.02, "4": 0.02 },
  "actions": ["tp_principal", "sl_all"],
  "tpMult": 3,
  "slPct": 10,
  "dest": "0xb079...",
  "infoSelector": "0x370158ea",
  "storeDir": "/cursor/stores/store-6b316fcf-4b71-4205-8a24-d84141fa9db3/pool-watch/<slug>"
}
```
