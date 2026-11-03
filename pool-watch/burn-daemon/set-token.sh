#!/usr/bin/env bash
# Usage: set-token.sh <token> [pair] [dest]
# If pair omitted: probe Pancake V2 pairs vs WBNB/USDT/USD1 and pick best liquidity.
set -euo pipefail
DIR=/home/box/burn-daemon
CFG="$DIR/config.json"
TOKEN=$(echo "${1:-}" | tr 'A-Z' 'a-z')
PAIR_ARG=$(echo "${2:-}" | tr 'A-Z' 'a-z')
DEST=$(echo "${3:-0xb079101b450e2caeb6df730e3a5a069ae263fc30}" | tr 'A-Z' 'a-z')
[[ "$TOKEN" =~ ^0x[a-f0-9]{40}$ ]] || { echo "usage: $0 <token> [pair] [dest]"; exit 2; }
[[ "$DEST" == "0xb079101b450e2caeb6df730e3a5a069ae263fc30" ]] || { echo "dest hard-fail"; exit 3; }

RPC=${RPC_URL:-https://bsc-dataseed.binance.org}
FACTORY=0xca143ce32fe78f1f7019d7d551a6402fc5350c73

if [[ -n "$PAIR_ARG" ]]; then
  PAIR="$PAIR_ARG"
  QUOTE=manual
else
  read -r PAIR QUOTE WBNB_EQ <<EOF
$(python3 - <<PY
import json,urllib.request
TOKEN="$TOKEN"
RPC="$RPC"
FACTORY="$FACTORY"
BASES=[
  ("WBNB","0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"),
  ("USDT","0x55d398326f99059ff775485246999027b3197955"),
  ("USD1","0x8d0d000ee44948d4c10bf1e9f43f61f9f6bd2b35"),
  ("USDC","0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"),
  ("BUSD","0xe9e7cea3dedca5984780bafc599bd69add087d56"),
]
def call(to,data):
  req=urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":to,"data":data},"latest"]}).encode(),headers={"content-type":"application/json"})
  return json.load(urllib.request.urlopen(req,timeout=10)).get("result") or "0x"
def get_pair(a,b):
  data="0xe6a43905"+a[2:].lower().zfill(64)+b[2:].lower().zfill(64)
  return "0x"+call(FACTORY,data)[-40:]
cands=[]
for name,base in BASES:
  p=get_pair(TOKEN,base)
  if int(p,16)==0: continue
  t0=("0x"+call(p,"0x0dfe1681")[-40:]).lower()
  t1=("0x"+call(p,"0xd21220a7")[-40:]).lower()
  hex=call(p,"0x0902f1ac")[2:]
  r0=int(hex[:64],16); r1=int(hex[64:128],16)
  base_l=base.lower()
  base_amt = r0 if t0==base_l else r1 if t1==base_l else 0
  # score: prefer non-zero liq; WBNB in BNB units, stables ~USD
  score=base_amt/1e18
  cands.append((score,name,p.lower(),base_amt/1e18))
cands.sort(reverse=True)
print("candidates:", file=__import__('sys').stderr)
for s,n,p,a in cands:
  print(f"  {n} pair={p} reserve≈{a}", file=__import__('sys').stderr)
if not cands:
  raise SystemExit("no V2 pairs found vs WBNB/USDT/USD1/USDC/BUSD")
# pick highest reserve (even if 0 — pre-open pool)
best=cands[0]
print(best[2], best[1], best[3])
PY
)
EOF
fi

python3 - <<PY
import json
from pathlib import Path
p=Path("$CFG")
c=json.loads(p.read_text()) if p.exists() else {}
c.update({
  "token":"$TOKEN",
  "pair":"$PAIR",
  "quote":"$QUOTE",
  "dest":"$DEST",
  "binanceChainId":56,
  "minWbnb": float(c.get("minWbnb") or 0.01),
  "minQuote": float(c.get("minQuote") or 0.01),
  "intervalMs": int(c.get("intervalMs") or 1000),
  "gasLevel": c.get("gasLevel") or "HIGH",
  "bawBin": c.get("bawBin") or "baw",
  "sessionDirs": c.get("sessionDirs") or ["~/.baw-wallets/w1","~/.baw-wallets/w2","~/.baw-wallets/w3","~/.baw-wallets/w4"],
  "rpcs": c.get("rpcs") or ["https://bsc-dataseed.binance.org","https://bsc-dataseed.bnbchain.org","https://bsc.drpc.org"],
  "once": True,
  "requireArm": True,
  "dryRun": False,
})
# for non-WBNB pairs, watch script uses minWbnb against WBNB side only — update watcher next
p.write_text(json.dumps(c, indent=2)+"\n")
print(json.dumps({"token":c["token"],"pair":c["pair"],"quote":c.get("quote"),"dest":c["dest"]}, indent=2))
PY

rm -f "$DIR/transferred.flag" "$DIR/STOP"
touch "$DIR/armed.flag"
pkill -f '/home/box/burn-daemon/watch-transfer.mjs' 2>/dev/null || true
if ! pgrep -f '/home/box/burn-daemon/supervise.sh' >/dev/null; then
  nohup /home/box/burn-daemon/supervise.sh >/home/box/burn-daemon/nohup.out 2>&1 &
  echo "supervise restarted pid=$!"
fi
echo "OK: armed token=$TOKEN pair=$PAIR quote=$QUOTE"
