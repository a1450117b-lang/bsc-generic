#!/usr/bin/env bash
# Poll Burn/WBNB pair every ~1s; on liquidity open → transfer_all once
set -euo pipefail
TOKEN=0x7de1606230aa70802caecf1a3e90039a6265b1c4
PAIR=0x53895464c524c6fdd82ad5189bf92d9b798c6a51
WBNB=0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c
DIR=/workspace/pool-watch/burn
FLAG="$DIR/transferred.flag"
LOG="$DIR/watch.log"
RPCS=(https://bsc-dataseed.binance.org https://bsc-dataseed.bnbchain.org https://bsc.drpc.org)
MIN_WBNB=0.01

echo "$(date -Iseconds) watch start pair=$PAIR" | tee -a "$LOG"
if [[ -f "$FLAG" ]]; then
  echo "$(date -Iseconds) already transferred, exit" | tee -a "$LOG"
  exit 0
fi

rpc_call() {
  local rpc="$1" to="$2" data="$3"
  curl -s --max-time 4 "$rpc" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$to\",\"data\":\"$data\"},\"latest\"]}"
}

is_open() {
  local rpc res t0 t1 hex r0 r1 wbnb
  for rpc in "${RPCS[@]}"; do
    res=$(rpc_call "$rpc" "$PAIR" "0x0dfe1681" || true)
    t0=$(python3 -c 'import sys,json; r=json.load(sys.stdin).get("result") or ""; print(("0x"+r[-40:]).lower() if r and len(r)>=42 else "")' <<<"$res" 2>/dev/null || true)
    [[ -n "$t0" ]] || continue
    res=$(rpc_call "$rpc" "$PAIR" "0xd21220a7" || true)
    t1=$(python3 -c 'import sys,json; r=json.load(sys.stdin).get("result") or ""; print(("0x"+r[-40:]).lower() if r and len(r)>=42 else "")' <<<"$res" 2>/dev/null || true)
    res=$(rpc_call "$rpc" "$PAIR" "0x0902f1ac" || true)
    hex=$(python3 -c 'import sys,json; print((json.load(sys.stdin).get("result") or "0x")[2:])' <<<"$res" 2>/dev/null || true)
    [[ ${#hex} -ge 128 ]] || continue
    r0=$(python3 -c "print(int('$hex'[:64],16))")
    r1=$(python3 -c "print(int('$hex'[64:128],16))")
    wbnb=0
    if [[ "$t0" == "$WBNB" ]]; then wbnb=$r0
    elif [[ "$t1" == "$WBNB" ]]; then wbnb=$r1
    fi
    python3 -c "import sys; sys.exit(0 if $wbnb/1e18 >= $MIN_WBNB else 1)" && {
      echo "OPEN wbnb=$(python3 -c "print($wbnb/1e18)") rpc=$rpc"
      return 0
    }
    return 1
  done
  return 1
}

n=0
while true; do
  n=$((n+1))
  if out=$(is_open); then
    echo "$(date -Iseconds) POOL OPEN: $out" | tee -a "$LOG"
    touch "$FLAG"
    /workspace/pool-watch/burn/transfer-all.sh 2>&1 | tee -a "$DIR/transfer.log"
    echo "$(date -Iseconds) transfer done" | tee -a "$LOG"
    # also dump check.mjs state
    node /workspace/pool-watch/check.mjs --dir burn >>"$LOG" 2>&1 || true
    exit 0
  fi
  if (( n % 30 == 0 )); then
    echo "$(date -Iseconds) still closed tick=$n" >>"$LOG"
  fi
  sleep 1
done
