# Burn 开池秒转（Node + systemd）

每秒检测 Pancake 池流动性；`WBNB` 储备 ≥ `minWbnb` 时，四号并行 `baw wallet send --max` 转到 `dest`。

## 你电脑上安装（Linux + systemd）

1. 安装 Node ≥ 18、全局 `baw`（`@binance/agentic-wallet`），并保证四号 `~/.baw-wallets/w1..w4/session.json` 已登录。
2. 在币安钱包 App 把收款地址 `0xb079101b450e2caeb6df730e3a5a069ae263fc30` **加入地址簿**（否则会 00351703 拒单）。
3. 拷贝本目录到家目录：

```bash
mkdir -p ~/burn-daemon
# 把本目录文件拷过去后：
cp -a watch-transfer.mjs config.json burn-pool-watch.service ~/burn-daemon/
mkdir -p ~/.config/systemd/user
cp ~/burn-daemon/burn-pool-watch.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now burn-pool-watch.service
journalctl --user -u burn-pool-watch.service -f
```

4. 停用：`systemctl --user stop burn-pool-watch.service`
5. 再盯下一轮：删 `~/burn-daemon/transferred.flag` 后 `systemctl --user restart burn-pool-watch.service`

## 配置

编辑 `config.json`：`token` / `pair` / `dest` / `intervalMs` / `sessionDirs`。`dest` 写死校验，改错会直接退出。

## 注意

- 转账需 BAW 地址簿；卖币不受此限。
- `once: true` 开池转完进程退出；systemd `Restart=on-failure` 只在异常时拉起。若要反复盯，设 `once: false` 并自己清 flag 逻辑。

## 保险开关

- 必须存在 `armed.flag` 才会真转（`requireArm: true`）。
- `touch ~/burn-daemon/armed.flag` 后再 `systemctl --user restart burn-pool-watch.service`。
- `dryRun: true` 只记开池、不发交易。
