#!/usr/bin/env bash
# Fire 4-wallet invite-train via BAW without waiting receipts/VRF between wallets.
# SAFE DEFAULT: without EXECUTE=1, only prints the plan and exits 0.
set -euo pipefail

PLAN="${PLAN_FILE:-/tmp/invite-train-plan.json}"
OUT="${RESULT_FILE:-/tmp/invite-train-results.json}"

if [[ ! -f "$PLAN" ]]; then
  echo "missing plan: $PLAN (run invite-train.mjs first)" >&2
  exit 1
fi

if [[ "${EXECUTE:-0}" != "1" ]]; then
  echo "[baw-train] EXECUTE!=1 — dry print only (no preview/execute)"
  echo "plan: $PLAN"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.train[] | "w\(.wallet) from=\(.from) to=\(.to) value=\(.value) data=\(.inputData[:18])… inviter=\(.inviter)"' "$PLAN"
  else
    cat "$PLAN"
  fi
  echo "[baw-train] would: for w=1..4: cp ~/.baw-wallets/w\$w/session.json ~/.baw/session.json && baw contract-call preview … && baw contract-call execute --requestId …"
  exit 0
fi

# --- live path (only when EXECUTE=1) ---
command -v baw >/dev/null 2>&1 || { echo "baw not found" >&2; exit 127; }
command -v jq >/dev/null 2>&1 || { echo "jq required for EXECUTE=1" >&2; exit 127; }

mint=$(jq -r '.mint' "$PLAN")
n=$(jq '.train | length' "$PLAN")
results='[]'
echo "[baw-train] EXECUTE=1 mint=$mint wallets=$n"

for i in $(seq 0 $((n - 1))); do
  w=$((i + 1))
  from=$(jq -r ".train[$i].from" "$PLAN")
  to=$(jq -r ".train[$i].to" "$PLAN")
  value=$(jq -r ".train[$i].value" "$PLAN")
  data=$(jq -r ".train[$i].inputData" "$PLAN")

  sess="$HOME/.baw-wallets/w${w}/session.json"
  if [[ ! -f "$sess" ]]; then
    echo "[baw-train] missing session $sess" >&2
    results=$(jq -c --argjson w "$w" --arg e "missing session" '. + [{wallet:$w, ok:false, error:$e}]' <<<"$results")
    continue
  fi
  mkdir -p "$HOME/.baw"
  cp "$sess" "$HOME/.baw/session.json"

  echo "[baw-train] w$w preview from=$from"
  prev_json=$(baw contract-call preview \
    --to "$to" \
    --data "$data" \
    --value "$value" \
    --json 2>&1) || true
  req=$(jq -r '.requestId // .request_id // empty' <<<"$prev_json" 2>/dev/null || true)
  if [[ -z "$req" ]]; then
    # try alternate preview flag shapes some baw builds use
    prev_json=$(baw contract-call preview --address "$to" --calldata "$data" --value "$value" --json 2>&1) || true
    req=$(jq -r '.requestId // .request_id // empty' <<<"$prev_json" 2>/dev/null || true)
  fi
  if [[ -z "$req" ]]; then
    echo "[baw-train] w$w preview failed / no requestId" >&2
    results=$(jq -c --argjson w "$w" --arg e "preview failed" --arg raw "$prev_json" \
      '. + [{wallet:$w, ok:false, error:$e, raw:($raw|.[0:300])}]' <<<"$results")
    continue
  fi

  echo "[baw-train] w$w execute requestId=$req"
  exec_json=$(baw contract-call execute --requestId "$req" --json 2>&1) || true
  hash=$(jq -r '.hash // .txHash // .transactionHash // empty' <<<"$exec_json" 2>/dev/null || true)
  echo "[baw-train] w$w hash=${hash:-unknown}"
  results=$(jq -c --argjson w "$w" --arg from "$from" --arg hash "${hash:-}" --arg raw "$exec_json" \
    '. + [{wallet:$w, from:$from, ok:($hash!=""), hash:$hash, raw:($raw|.[0:400])}]' <<<"$results")
  # do NOT wait for receipt/VRF — immediately next wallet
done

echo "$results" | jq '.' >"$OUT"
echo "[baw-train] wrote $OUT"
jq -r '.[] | "w\(.wallet) ok=\(.ok) hash=\(.hash // "-")"' "$OUT"
