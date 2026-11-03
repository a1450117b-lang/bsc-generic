#!/usr/bin/env bash
# Parallel 4-wallet sell on BSC. BAW market-order first; on liquidity/amount fail → Pancake router.
# Usage: sell-all.sh <tokenAddress> [qtyPerWallet]
# Env: TO_TOKEN=auto|USDT|WBNB|0x..  TOKENS_PER_UNIT  SKIP_BAL=1  GAS  MEV  SLIPPAGE  DRY_RUN
#      PANCAKE_FALLBACK=1 (default)  AMOUNT_RAW (optional exact raw; else qty*TOKENS_PER_UNIT)
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"

USDT=0x55d398326f99059fF775485246999027B3197955
WBNB=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
ROUTER=0x10ED43C718714eb63d5aA57B78B54704E256024E
FACTORY=0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
CHAIN=56
RPC="${RPC_URL:-https://bsc-dataseed.binance.org}"
WALLETS=(
  0x0ABABF8eF7A083A580b4662d7e4e39Af32DBbEd1
  0xd7857acc2a935570d14a1c847c9B056eC7071fF2
  0x2DBf34008CEb2Cd771f573D8FF1abEc95b2D777f
  0x1727420C362B89B038869423e33644bcA33bbC8d
)
QUOTES=(
  "WBNB:$WBNB"
  "USDT:$USDT"
  "USD1:0x8d0d000ee44948d4c10bf1e9f43f61f9f6bd2b35"
  "USDC:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"
  "BUSD:0xe9e7cea3dedca5984780bafc599bd69add087d56"
)

usage() {
  cat <<'U'
Usage: sell-all.sh <tokenAddress> [qtyPerWallet]
  Parallel sell via baw market-order; on fail → Pancake supportingFee swap.
  Env: TO_TOKEN=auto|USDT|WBNB|0x.., TOKENS_PER_UNIT, SKIP_BAL=1, GAS, MEV, SLIPPAGE, DRY_RUN=1,
       PANCAKE_FALLBACK=1, AMOUNT_RAW
U
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -lt 1 ]]; then
  usage; exit 0
fi

TOKEN=$(echo "$1" | tr 'A-Z' 'a-z')
QTY_ARG="${2:-}"
MEV="${MEV:-true}"
GAS="${GAS:-HIGH}"
SLIPPAGE="${SLIPPAGE:-auto}"
DRY_RUN="${DRY_RUN:-0}"
TO_TOKEN_RAW="${TO_TOKEN:-auto}"
PANCAKE_FALLBACK="${PANCAKE_FALLBACK:-1}"
TOKENS_PER_UNIT="${TOKENS_PER_UNIT:-1e18}"

if [[ ! "$TOKEN" =~ ^0x[a-f0-9]{40}$ ]]; then
  echo "bad token: $TOKEN" >&2; exit 2
fi
command -v baw >/dev/null || { echo "baw not in PATH" >&2; exit 2; }

rpc_call() {
  local to="$1" data="$2"
  curl -s "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$to\",\"data\":\"$data\"},\"latest\"]}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result") or "0x0")'
}

pick_to_token() {
  local want="$1"
  if [[ "$want" == "USDT" || "$want" == "usdt" ]]; then echo "$USDT"; return; fi
  if [[ "$want" == "WBNB" || "$want" == "wbnb" || "$want" == "BNB" || "$want" == "bnb" ]]; then echo "$WBNB"; return; fi
  if [[ "$want" =~ ^0x[a-fA-F0-9]{40}$ ]]; then echo "$want" | tr 'A-Z' 'a-z'; return; fi
  # auto: largest V2 quote reserve among known quotes
  python3 - <<PY
import json,urllib.request
RPC="$RPC"; TOKEN="${TOKEN#0x}"; FACTORY="$FACTORY"
quotes=[("WBNB","${WBNB#0x}".lower()),("USDT","${USDT#0x}".lower()),
 ("USD1","8d0d000ee44948d4c10bf1e9f43f61f9f6bd2b35"),
 ("USDC","8ac76a51cc950d9822d68b83fe1ad97b32cd580d"),
 ("BUSD","e9e7cea3dedca5984780bafc599bd69add087d56")]
def rpc(method,params):
  req=urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),headers={"content-type":"application/json"})
  return json.load(urllib.request.urlopen(req,timeout=12))
best=None; best_r=0
for name,q in quotes:
  data="0xe6a43905"+TOKEN.zfill(64)+q.zfill(64)
  pair="0x"+rpc("eth_call",[{"to":FACTORY,"data":data},"latest"])["result"][-40:]
  if int(pair,16)==0: continue
  raw=rpc("eth_call",[{"to":pair,"data":"0x0902f1ac"},"latest"])["result"]
  r0=int(raw[2:66],16); r1=int(raw[66:130],16)
  t0="0x"+rpc("eth_call",[{"to":pair,"data":"0x0dfe1681"},"latest"])["result"][-40:]
  qres = r1 if t0.lower()==("0x"+TOKEN).lower() else r0
  if qres>best_r:
    best_r=qres; best=("0x"+q, name, pair, qres)
if not best:
  print("$USDT"); print("auto→USDT (no pool)", file=__import__("sys").stderr)
else:
  print(best[0])
  print(f"auto→{best[1]} pair={best[2]} quoteRes={best[3]}", file=__import__("sys").stderr)
PY
}

TO_TOKEN=$(pick_to_token "$TO_TOKEN_RAW")
TO_TOKEN=$(echo "$TO_TOKEN" | tr 'A-Z' 'a-z' | head -1)
IS_BNB=0
[[ "$TO_TOKEN" == "$(echo $WBNB | tr A-Z a-z)" ]] && IS_BNB=1

balance_of() {
  local wallet="$1"
  local data="0x70a08231$(printf '%064s' "${wallet#0x}" | tr ' ' '0')"
  local res; res=$(rpc_call "$TOKEN" "$data")
  python3 - <<PY
raw="$res"
n=int(raw,16) if raw and raw!="0x" else 0
from decimal import Decimal
scale=Decimal("$TOKENS_PER_UNIT")
print(float(Decimal(n)/scale))
print(n, file=__import__('sys').stderr)
PY
}

raw_amount_for_qty() {
  python3 -c "from decimal import Decimal, ROUND_DOWN; print(int((Decimal('$1')*Decimal('$TOKENS_PER_UNIT')).to_integral_value(rounding=ROUND_DOWN)))"
}

echo "sell-all token=$TOKEN to=$TO_TOKEN gas=$GAS mev=$MEV slip=$SLIPPAGE dry=$DRY_RUN skipBal=${SKIP_BAL:-0} pancake=$PANCAKE_FALLBACK unit=$TOKENS_PER_UNIT"

declare -a QTYS=( "" "" "" "" )
declare -a RAWS=( "" "" "" "" )
if [[ -n "${AMOUNT_RAW:-}" ]]; then
  for i in 0 1 2 3; do RAWS[$i]="$AMOUNT_RAW"; QTYS[$i]=$(python3 -c "print(int('$AMOUNT_RAW')/float('$TOKENS_PER_UNIT'))"); done
elif [[ -n "$QTY_ARG" ]]; then
  QTYS=("$QTY_ARG" "$QTY_ARG" "$QTY_ARG" "$QTY_ARG")
  for i in 0 1 2 3; do RAWS[$i]=$(raw_amount_for_qty "$QTY_ARG"); done
elif [[ "${SKIP_BAL:-0}" == "1" ]]; then
  QTYS=("999999999999" "999999999999" "999999999999" "999999999999")
  [[ -n "${QTY_W1:-}" ]] && QTYS[0]="$QTY_W1"
  [[ -n "${QTY_W2:-}" ]] && QTYS[1]="$QTY_W2"
  [[ -n "${QTY_W3:-}" ]] && QTYS[2]="$QTY_W3"
  [[ -n "${QTY_W4:-}" ]] && QTYS[3]="$QTY_W4"
  for i in 0 1 2 3; do RAWS[$i]=$(raw_amount_for_qty "${QTYS[$i]}"); done
else
  for i in 1 2 3 4; do
    (
      out=$(balance_of "${WALLETS[$((i-1))]}" 2>/tmp/baw-raw-w${i}.txt)
      echo "$out" >"/tmp/baw-bal-w${i}.txt"
    ) &
  done
  wait
  for i in 1 2 3 4; do
    QTYS[$((i-1))]=$(cat "/tmp/baw-bal-w${i}.txt")
    RAWS[$((i-1))]=$(cat "/tmp/baw-raw-w${i}.txt" | head -1)
  done
fi

pancake_sell_one() {
  local i="$1" wallet="$2" raw="$3" thome="$4"
  local amt_hex out_min_hex deadline path0 path1 data approve_data rid prev
  amt_hex=$(python3 -c "print(hex(int('$raw'))[2:].zfill(64))")
  # getAmountsOut for minOut * 0.5
  path0=$(printf '%064s' "${TOKEN#0x}" | tr ' ' '0')
  path1=$(printf '%064s' "${TO_TOKEN#0x}" | tr ' ' '0')
  local quote_data="0xd06ca61f${amt_hex}00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000002${path0}${path1}"
  local qres; qres=$(rpc_call "$ROUTER" "$quote_data" || echo 0x0)
  out_min_hex=$(python3 - <<PY
raw="$qres"
try:
  # abi: offset, len, a0, a1
  b=bytes.fromhex(raw[2:])
  # amounts[1] is last 32 of the two amounts; dynamic: skip offset(32)+len(32)+amount0(32) → amount1
  if len(b)<128: print('0'*64)
  else:
    # decode properly
    off=int.from_bytes(b[0:32],'big'); n=int.from_bytes(b[off:off+32],'big')
    a1=int.from_bytes(b[off+32+32:off+32+64],'big') if n>=2 else 0
    print(hex(a1//2)[2:].zfill(64))
except Exception:
  print('0'*64)
PY
)
  deadline=$(python3 -c "import time; print(hex(int(time.time())+600)[2:].zfill(64))")
  local tohex; tohex=$(printf '%064s' "${wallet#0x}" | tr ' ' '0' | tr 'A-F' 'a-f')
  approve_data="0x095ea7b3$(printf '%064s' "${ROUTER#0x}" | tr ' ' '0' | tr 'A-F' 'a-f')${amt_hex}"
  if [[ "$IS_BNB" == "1" ]]; then
    data="0x791ac947${amt_hex}${out_min_hex}00000000000000000000000000000000000000000000000000000000000000a0${tohex}${deadline}0000000000000000000000000000000000000000000000000000000000000002${path0}${path1}"
  else
    data="0x5c11d795${amt_hex}${out_min_hex}00000000000000000000000000000000000000000000000000000000000000a0${tohex}${deadline}00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002${path0}${path1}"
  fi
  echo "[w${i}] pancake approve raw=$raw"
  prev=$(HOME="$thome" baw contract-call preview --binanceChainId "$CHAIN" --from "$wallet" --to "$TOKEN" --value 0 --inputData "$approve_data" --json 2>&1) || true
  rid=$(python3 -c "import json,sys; 
try:
 d=json.loads('''$(echo "$prev" | sed "s/'/\\\\'/g" | tr -d '\n' | head -c 50000)''')
except Exception:
 import re; m=re.search(r'requestId[\"']?\s*[:=]\s*[\"']([^\"']+)', sys.stdin.read() if False else '''$prev''');
print('')
" 2>/dev/null || true)
  rid=$(echo "$prev" | python3 -c "import sys,json,re; t=sys.stdin.read()
try:
 j=json.loads(t); print(j.get('data',{}).get('requestId') or j.get('requestId') or '')
except Exception:
 m=re.search(r'requestId\"?\s*:\s*\"([^\"]+)\"', t); print(m.group(1) if m else '')")
  [[ -z "$rid" ]] && { echo "[w${i}] pancake approve no rid"; echo "$prev" | tail -c 800; return 1; }
  HOME="$thome" baw contract-call execute --requestId "$rid" --json 2>&1 | tee -a "/tmp/baw-sell-w${i}.log" >/dev/null
  echo "[w${i}] pancake swap"
  prev=$(HOME="$thome" baw contract-call preview --binanceChainId "$CHAIN" --from "$wallet" --to "$ROUTER" --value 0 --inputData "$data" --json 2>&1) || true
  rid=$(echo "$prev" | python3 -c "import sys,json,re; t=sys.stdin.read()
try:
 j=json.loads(t); print(j.get('data',{}).get('requestId') or j.get('requestId') or '')
except Exception:
 m=re.search(r'requestId\"?\s*:\s*\"([^\"]+)\"', t); print(m.group(1) if m else '')")
  [[ -z "$rid" ]] && { echo "[w${i}] pancake swap no rid"; echo "$prev" | tail -c 800; return 1; }
  HOME="$thome" baw contract-call execute --requestId "$rid" --json 2>&1
}

pids=()
for i in 1 2 3 4; do
  sess="${HOME}/.baw-wallets/w${i}/session.json"
  if [[ ! -f "$sess" ]]; then
    echo "missing session w${i}: $sess" >&2; exit 3
  fi
  thome="/tmp/bawhome-w${i}"
  mkdir -p "$thome/.baw"
  cp "$sess" "$thome/.baw/session.json"
  wallet="${WALLETS[$((i-1))]}"
  qty="${QTYS[$((i-1))]}"
  raw="${RAWS[$((i-1))]}"
  if [[ "${SKIP_BAL:-0}" != "1" ]]; then
    python3 -c "import sys; sys.exit(0 if float('$qty' or 0)>0 else 1)" || {
      echo "[w${i}] skip qty=$qty"; continue
    }
  fi
  log="/tmp/baw-sell-w${i}.log"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[w${i}] DRY_RUN would sell qty=$qty raw=$raw → $TO_TOKEN"
    continue
  fi
  (
    echo "[w${i}] start $(date +%T) qty=$qty raw=$raw wallet=$wallet → $TO_TOKEN"
    set +e
    HOME="$thome" baw market-order swap \
      --binanceChainId "$CHAIN" \
      --fromTokenQty "$qty" \
      --fromToken "$TOKEN" \
      --toToken "$TO_TOKEN" \
      --slippage "$SLIPPAGE" \
      --mev "$MEV" \
      --gasLevel "$GAS"
    ec=$?
    set -e
    if [[ $ec -ne 0 && "$PANCAKE_FALLBACK" == "1" && -n "$raw" && "$raw" != "0" ]]; then
      echo "[w${i}] BAW failed ec=$ec → pancake fallback"
      pancake_sell_one "$i" "$wallet" "$raw" "$thome" || ec=$?
    fi
    echo "[w${i}] exit $ec"
    exit $ec
  ) >"$log" 2>&1 &
  pids+=($!)
  echo "launched w${i} pid $! qty=$qty → $log"
done

if [[ ${#pids[@]} -eq 0 ]]; then
  echo "nothing to sell"; exit 0
fi
ec=0
for pid in "${pids[@]}"; do
  wait "$pid" || ec=1
done
echo "---- summary ----"
for i in 1 2 3 4; do
  [[ -f /tmp/baw-sell-w${i}.log ]] && { echo "=== w${i} ==="; cat /tmp/baw-sell-w${i}.log; }
done
exit $ec
