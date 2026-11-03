#!/usr/bin/env bash
# Four-wallet parallel BAW contract-call. Usage:
#   EXECUTE=1 bash parallel-mint.sh <to> <inputDataHex> [valueWei=0]
# Optional env: APPROVE_TO APPROVE_DATA (exact USDT approve before mint, per wallet)
# Wallets w1..w4 from ~/.baw-wallets; isolates HOME so sessions don't clash.
set -euo pipefail
TO=${1:?to}; DATA=${2:?inputData}; VALUE=${3:-0}
W=(
  "0x0ABABF8eF7A083A580b4662d7e4e39Af32DBbEd1"
  "0xd7857acc2a935570d14a1c847c9B056eC7071fF2"
  "0x2DBf34008CEb2Cd771f573D8FF1abEc95b2D777f"
  "0x1727420C362B89B038869423e33644bcA33bbC8d"
)
OUT=/tmp/parallel-mint-results.json
echo '[]' > "$OUT"
run_one() {
  local n=$1 addr=$2
  local thome=/tmp/bawhome-w$n log=/tmp/parallel-w$n.log
  mkdir -p "$thome/.baw"
  cp -a ~/.baw/. "$thome/.baw/" 2>/dev/null || true
  cp ~/.baw-wallets/w$n/session.json "$thome/.baw/session.json"
  {
    echo "W$n start $(date +%T)"
    if [[ -n "${APPROVE_TO:-}" && -n "${APPROVE_DATA:-}" ]]; then
      PREV=$(HOME="$thome" baw contract-call preview --binanceChainId 56 --from "$addr" --to "$APPROVE_TO" --value 0 --inputData "$APPROVE_DATA" --json)
      RID=$(echo "$PREV" | jq -r '.data.requestId // empty')
      echo "W$n approve rid=$RID"
      [[ -n "$RID" ]] && HOME="$thome" baw contract-call execute --requestId "$RID" --json | tee /tmp/parallel-w$n-ap.json
    fi
    PREV=$(HOME="$thome" baw contract-call preview --binanceChainId 56 --from "$addr" --to "$TO" --value "$VALUE" --inputData "$DATA" --json)
    RID=$(echo "$PREV" | jq -r '.data.requestId // empty')
    echo "W$n mint rid=$RID"
    if [[ -n "$RID" ]]; then
      HOME="$thome" baw contract-call execute --requestId "$RID" --json | tee /tmp/parallel-w$n-m.json
    else
      echo "$PREV" | tee /tmp/parallel-w$n-m.json
    fi
    echo "W$n done $(date +%T)"
  } >"$log" 2>&1
}
if [[ "${EXECUTE:-}" != "1" ]]; then
  echo "[parallel-mint] EXECUTE!=1 dry: would parallel w1..w4 to=$TO value=$VALUE data=${DATA:0:18}…"
  exit 0
fi
for i in 0 1 2 3; do run_one $((i+1)) "${W[$i]}" & done
wait
jq -s '{wallets:., t: now}' /tmp/parallel-w{1,2,3,4}-m.json > "$OUT" 2>/dev/null || true
echo "PARALLEL_DONE results=$OUT"
for n in 1 2 3 4; do echo "---- W$n ----"; tail -8 /tmp/parallel-w$n.log; done
