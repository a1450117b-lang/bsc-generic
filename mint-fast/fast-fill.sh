#!/usr/bin/env bash
# Fast paid/free fill: no balance scan. Usage:
#   EXECUTE=1 bash fast-fill.sh <to> <inputDataHex> [valueWei=0]
# Optional: APPROVE_TO APPROVE_DATA, SWAP_TO SWAP_DATA (run before mint if set)
set -euo pipefail
TO=${1:?to}; DATA=${2:?data}; VALUE=${3:-0}
W=(
  "0x0ABABF8eF7A083A580b4662d7e4e39Af32DBbEd1"
  "0xd7857acc2a935570d14a1c847c9B056eC7071fF2"
  "0x2DBf34008CEb2Cd771f573D8FF1abEc95b2D777f"
  "0x1727420C362B89B038869423e33644bcA33bbC8d"
)
run_one() {
  local n=$1 addr=$2 thome=/tmp/bawhome-w$n
  mkdir -p "$thome/.baw"; cp -a ~/.baw/. "$thome/.baw/" 2>/dev/null || true
  cp ~/.baw-wallets/w$n/session.json "$thome/.baw/session.json"
  {
    if [[ -n "${APPROVE_TO:-}" && -n "${APPROVE_DATA:-}" ]]; then
      RID=$(HOME="$thome" baw contract-call preview --binanceChainId 56 --from "$addr" --to "$APPROVE_TO" --value 0 --inputData "$APPROVE_DATA" --json | jq -r '.data.requestId // empty')
      [[ -n "$RID" ]] && HOME="$thome" baw contract-call execute --requestId "$RID" --json >/tmp/fast-w$n-ap.json
    fi
    if [[ -n "${SWAP_TO:-}" && -n "${SWAP_DATA:-}" ]]; then
      RID=$(HOME="$thome" baw contract-call preview --binanceChainId 56 --from "$addr" --to "$SWAP_TO" --value 0 --inputData "$SWAP_DATA" --json | jq -r '.data.requestId // empty')
      [[ -n "$RID" ]] && HOME="$thome" baw contract-call execute --requestId "$RID" --json >/tmp/fast-w$n-sw.json
    fi
    PREV=$(HOME="$thome" baw contract-call preview --binanceChainId 56 --from "$addr" --to "$TO" --value "$VALUE" --inputData "$DATA" --json)
    RID=$(echo "$PREV" | jq -r '.data.requestId // empty')
    if [[ -n "$RID" ]]; then HOME="$thome" baw contract-call execute --requestId "$RID" --json | tee /tmp/fast-w$n-m.json
    else echo "$PREV" | tee /tmp/fast-w$n-m.json; fi
  } >/tmp/fast-w$n.log 2>&1
}
[[ "${EXECUTE:-}" == "1" ]] || { echo "dry"; exit 0; }
for i in 0 1 2 3; do run_one $((i+1)) "${W[$i]}" & done
wait
jq -s '{wallets:.,t:now}' /tmp/fast-w{1,2,3,4}-m.json > /tmp/fast-fill-results.json 2>/dev/null || true
echo FAST_FILL_DONE
for n in 1 2 3 4; do echo "----W$n----"; tail -6 /tmp/fast-w$n.log; done
