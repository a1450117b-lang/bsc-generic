#!/usr/bin/env bash
# Parallel transfer TOKEN → DEST for w1-w4 — no pre-balance check; --max skips empty
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"
TOKEN=0x7de1606230aa70802caecf1a3e90039a6265b1c4
DEST=0xb079101b450e2caeb6df730e3a5a069ae263fc30
CHAIN=56
[[ "$DEST" == "0xb079101b450e2caeb6df730e3a5a069ae263fc30" ]] || { echo "DEST mismatch, abort"; exit 3; }
echo "transfer-all (no bal check) token=$TOKEN dest=$DEST $(date -Iseconds)"
pids=()
for i in 1 2 3 4; do
  sess="/home/box/.baw-wallets/w${i}/session.json"
  [[ -f "$sess" ]] || { echo "missing session w$i"; exit 3; }
  thome="/tmp/bawhome-w${i}"
  mkdir -p "$thome/.baw"
  cp "$sess" "$thome/.baw/session.json"
  log="/tmp/baw-xfer-burn-w${i}.log"
  (
    echo "[w$i] start $(date +%T.%3N) → $DEST"
    HOME="$thome" baw wallet send \
      --binanceChainId "$CHAIN" \
      --max \
      --tokenAddress "$TOKEN" \
      --recipient "$DEST" \
      --gasLevel HIGH
    echo "[w$i] exit $?"
  ) >"$log" 2>&1 &
  pids+=($!)
  echo "launched w$i pid $!"
done
ec=0
for pid in "${pids[@]}"; do wait "$pid" || ec=1; done
echo "---- summary ----"
for i in 1 2 3 4; do
  [[ -f /tmp/baw-xfer-burn-w${i}.log ]] && { echo "=== w$i ==="; cat /tmp/baw-xfer-burn-w${i}.log; }
done
exit $ec
