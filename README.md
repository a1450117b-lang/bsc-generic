# BSC 通用脚本包

BNB Chain（BSC）上的打新、卖出、开池监控脚本。签名和广播都走本机已登录的 Binance Agentic Wallet CLI（命令 `baw`，包名 `@binance/agentic-wallet`）。

**本仓库不含钱包。** 没有 session、私钥或助记词。脚本里出现的 `0x` 地址是链上公开地址（合约或收款方），不能用来签名。

## 克隆

```bash
git clone https://github.com/a1450117b-lang/bsc-generic.git
cd bsc-generic
```

仓库地址：<https://github.com/a1450117b-lang/bsc-generic>

## 单独安装 baw

`baw` 不在本仓库里，需要自己装。建议 Node.js ≥ 18。

```bash
npm install -g @binance/agentic-wallet
baw --help
```

广播类脚本会读取本机四个已登录会话（请自行登录，不要把这些文件提交进来）：

```text
~/.baw-wallets/w1/session.json
~/.baw-wallets/w2/session.json
~/.baw-wallets/w3/session.json
~/.baw-wallets/w4/session.json
```

只查链、不签名的脚本（例如 `bsc-mint-skill/precheck.mjs`、`mint-fast/check.mjs`、`pool-watch/check.mjs`）不需要 session。

## 目录

| 路径 | 作用 |
| --- | --- |
| `bsc-mint-skill/` | 只读预检：URL 或 CA → 合约、mint 函数、单价、四号模拟、风险、历史匹配 |
| `mint-fast/` | 打新询价、四号并行 mint、邀请火车、Mars `claimReferral` |
| `sell-fast/` | 四号并行市价卖到 USDT（失败时回退 Pancake router） |
| `pool-watch/` | 开池 / 倍数 / 止损检查；示例与 burn 配置。只检查，不自动卖 |
| `skills/` | 四条流程的操作说明（Cursor skill） |

### `bsc-mint-skill/`

只读预检，不签名、不广播。依赖在该目录里用 `npm install` 安装（ethers v6）。

```bash
node bsc-mint-skill/precheck.mjs <url-or-CA>
```

操作说明：`skills/bsc-mint-precheck.md`。

### `mint-fast/`

- `check.mjs <url|0x合约> [--shares=10]`：单价、进度、四号 `eth_call` 模拟
- `parallel-mint.sh`、`fast-fill.sh`：四号并行 `baw contract-call`（需本机 session）
- `invite-train.mjs`、`baw-train.sh`：邀请火车
- `mars-claim.cjs`：Mars `claimReferral`

### `sell-fast/`

```bash
./sell-fast/sell-all.sh <token>
./sell-fast/sell-all.sh <token> <qtyPerWallet>
DRY_RUN=1 ./sell-fast/sell-all.sh <token>
```

### `pool-watch/`

`check.mjs` 按脚本所在目录读取 `pool-watch/<slug>/config.json`，写出 `last_state.json`，不卖、不转。

```bash
node pool-watch/check.mjs --dir examples/snowball
node pool-watch/check.mjs --dir grok
```

- `examples/bnbh`、`examples/snowball`、`examples/aipro`：配置与秒刷样例（`fast-watch.mjs`、`on-trigger-sell.sh`）
- `burn/`、`burn-daemon/`：开池后四号转到固定收款地址的示例（`burn-daemon` 含 systemd unit）
- `grok/`、`_selftest/`：一份实盘配置和自测配置

部分 shell 与 `skills/` 里仍写着原来的绝对路径 `/workspace/...`。克隆到别的目录后，把该前缀换成仓库根目录即可。`pool-watch/check.mjs` 本身用相对路径。

### `skills/`

- `bsc-mint-precheck.md`
- `bsc-mint-fast-check.md`
- `bsc-sell-fast.md`
- `bsc-pool-watch.md`

## 运行日志

`pool-watch/**/*.log` 和 `nohup.out` 是本机运行噪音，没有放进仓库。`.gitignore` 会继续挡住这些文件，以及 `session.json`。`bsc-mint-skill/node_modules/`、`cache/` 里的缓存，以及本地 `runs/*.json`、`bundles/*.json` 也不入库；这三个目录用 `.gitkeep` 留在仓库里。

## English

Clone:

```bash
git clone https://github.com/a1450117b-lang/bsc-generic.git
```

| Path | Role |
| --- | --- |
| `bsc-mint-skill/` | Read-only precheck: URL or CA → contract, mint fn, price, 4-wallet sims, risk, history match |
| `mint-fast/` | Quote, simulate, and parallel-mint on four local wallets |
| `sell-fast/` | Parallel market-sell to USDT |
| `pool-watch/` | Pool-open / take-profit / stop-loss checks, plus example configs |
| `skills/` | Operator notes for the four flows (`skills/bsc-mint-precheck.md` and the three execution flows) |

Read-only precheck:

```bash
node bsc-mint-skill/precheck.mjs <url-or-CA>
```

Wallets are **not** included: no sessions, private keys, or mnemonics. Install the signer yourself, then log in locally:

```bash
npm install -g @binance/agentic-wallet
```

Broadcast scripts expect `~/.baw-wallets/w1` … `w4/session.json` on the machine that runs them. Read-only checks (`bsc-mint-skill/precheck.mjs`, `mint-fast/check.mjs`, `pool-watch/check.mjs`) do not. Install precheck deps with `npm install` inside `bsc-mint-skill/`.
