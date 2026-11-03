#!/usr/bin/env bash
# Wait for TRIGGER.json then sell per rules. Writes /tmp/snowball-watch/SELL_RESULT.json
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"
OUT=/tmp/snowball-watch
TOKEN=0x79B5D86089a29a65faC3278572f00C8FADc361fb
TRIG="$OUT/TRIGGER.json"
SELL_ALL=/workspace/sell-fast/sell-all.sh
mkdir -p "$OUT"

echo "[sell-waiter] waiting for $TRIG $(date -Is)"
while [[ ! -f "$TRIG" ]]; do
  sleep 0.3
done

echo "[sell-waiter] TRIGGER seen $(date -Is)"
cp "$TRIG" "$OUT/TRIGGER.consumed.json"
ACTION=$(python3 -c 'import json; print(json.load(open("'"$TRIG"'")).get("action",""))')
MULT=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("mult"))')
QTY_P=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("sellQtyPrincipal") or "")')
WBNB=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("wbnb"))')
PRICE=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("priceBnb"))')

echo "[sell-waiter] action=$ACTION mult=$MULT qty_p=$QTY_P wbnb=$WBNB price=$PRICE"

# Tax/slip sanity: quote 1% of a wallet via router getAmountsOut if possible, else proceed with MEV on
# Quick pool vs expected: if mult is absurdly high (>50) or near-zero with big liq, stop
python3 - <<PY
mult=float("$MULT") if "$MULT" not in ("None","") else 0
wbnb=float("$WBNB") if "$WBNB" not in ("None","") else 0
if mult > 50:
  open("/tmp/snowball-watch/ABORT.json","w").write('{"reason":"mult_absurd","mult":%s}\n'%mult)
  raise SystemExit(10)
if wbnb < 0.01:
  open("/tmp/snowball-watch/ABORT.json","w").write('{"reason":"liq_too_low","wbnb":%s}\n'%wbnb)
  raise SystemExit(11)
print("sanity ok mult=%s wbnb=%s"%(mult, wbnb))
PY

rm -f /tmp/baw-sell-w{1,2,3,4}.log

if [[ "$ACTION" == "tp_principal" ]]; then
  # sell only principal qty per wallet
  QTY=$(python3 -c 'print(float("'"$QTY_P"'"))')
  echo "[sell-waiter] tp_principal qty=$QTY"
  GAS=HIGH MEV=true "$SELL_ALL" "$TOKEN" "$QTY" | tee "$OUT/sell-all.out"
else
  echo "[sell-waiter] sell_all full balance"
  GAS=HIGH MEV=true "$SELL_ALL" "$TOKEN" | tee "$OUT/sell-all.out"
fi

# Parse results
python3 - <<'PY'
import json,re,glob,os
from pathlib import Path
out={"wallets":{}, "action": open("/tmp/snowball-watch/TRIGGER.consumed.json").read()}
try:
  trig=json.load(open("/tmp/snowball-watch/TRIGGER.consumed.json"))
except: trig={}
out["trigger"]=trig
out["action_name"]=trig.get("action")
for i in range(1,5):
  p=f"/tmp/baw-sell-w{i}.log"
  text=Path(p).read_text() if Path(p).exists() else ""
  # try extract hash / received
  hashes=re.findall(r'0x[a-fA-F0-9]{64}', text)
  usdt=re.findall(r'(?:toTokenQty|received|amountOut|USDT)[^\d]*([\d.]+)', text, re.I)
  out["wallets"][f"w{i}"]={"log":text[-4000:], "hashes":hashes[-3:], "usdt_guess":usdt[-3:] if usdt else []}
Path("/tmp/snowball-watch/SELL_RESULT.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
print(json.dumps({k:{kk:vv for kk,vv in v.items() if kk!="log"} for k,v in out["wallets"].items()}, indent=2))
print("wrote SELL_RESULT.json")
PY
echo "[sell-waiter] done $(date -Is)"
