#!/usr/bin/env bash
# Wait for TRIGGER.json then sell per rules. Writes /tmp/aipro-watch/SELL_RESULT.json
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"
OUT=/tmp/aipro-watch
TOKEN=0x577bEa203E5326Ff6E1d4594A94167111836b286
PAIR=0x9ace87f96f41aa902688362e2387fbf7b3fbb91f
TRIG="$OUT/TRIGGER.json"
SELL_ALL=/workspace/sell-fast/sell-all.sh
ROUTER=0x10ed43c718714eb63d5aa57b78b54704e256024e
WBNB=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
USDT=0x55d398326f99059fF775485246999027B3197955
RPC="${RPC_URL:-https://bsc-dataseed.bnbchain.org}"
mkdir -p "$OUT"

echo "[sell-waiter] waiting for $TRIG $(date -Is)"
while [[ ! -f "$TRIG" ]]; do
  sleep 0.3
done

echo "[sell-waiter] TRIGGER seen $(date -Is)"
cp "$TRIG" "$OUT/TRIGGER.consumed.json"
ACTION=$(python3 -c 'import json; print(json.load(open("'"$TRIG"'")).get("action",""))')
MULT=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("mult"))')
MULT_MIN=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("multMin"))')
QTY_P=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("sellQtyPrincipal") or "")')
WBNB_LIQ=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("wbnb"))')
PRICE=$(python3 -c 'import json; d=json.load(open("'"$TRIG"'")); print(d.get("priceBnb"))')

echo "[sell-waiter] action=$ACTION mult=$MULT multMin=$MULT_MIN qty_p=$QTY_P wbnb=$WBNB_LIQ price=$PRICE"

python3 - <<PY
mult=float("$MULT") if "$MULT" not in ("None","") else 0
wbnb=float("$WBNB_LIQ") if "$WBNB_LIQ" not in ("None","") else 0
if mult > 50:
  open("/tmp/aipro-watch/ABORT.json","w").write('{"reason":"mult_absurd","mult":%s}\n'%mult)
  raise SystemExit(10)
if wbnb < 0.01:
  open("/tmp/aipro-watch/ABORT.json","w").write('{"reason":"liq_too_low","wbnb":%s}\n'%wbnb)
  raise SystemExit(11)
print("sanity ok mult=%s wbnb=%s"%(mult, wbnb))
PY

# Tax/loss check via router getAmountsOut on ~1% of a 550M bag (5.5M tokens)
python3 - <<'PY'
import json,urllib.request
RPC="https://bsc-dataseed.bnbchain.org"
TOKEN="0x577bea203e5326ff6e1d4594a94167111836b286"
ROUTER="0x10ed43c718714eb63d5aa57b78b54704e256024e"
WBNB="0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
USDT="0x55d398326f99059ff775485246999027b3197955"
trig=json.load(open("/tmp/aipro-watch/TRIGGER.consumed.json"))
price=float(trig.get("priceBnb") or 0)
qty=5_500_000  # 1% of 550M
amt=int(qty*1e18)
def enc(a): return a.lower().replace("0x","").rjust(64,"0")
def rpc(to,data):
  body=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":to,"data":data},"latest"]}).encode()
  req=urllib.request.Request(RPC,data=body,headers={"content-type":"application/json"})
  with urllib.request.urlopen(req,timeout=10) as r:
    j=json.load(r)
  if "error" in j: raise Exception(j["error"])
  return j["result"]
# path token->wbnb->usdt
data="0xd06ca61f"+amt.to_bytes(32,"big").hex()+(0x40).to_bytes(32,"big").hex()+(3).to_bytes(32,"big").hex()+enc(TOKEN)+enc(WBNB)+enc(USDT)
try:
  out=rpc(ROUTER,data)[2:]
  # returns array; last amount at end
  # ABI: offset, len, a0, a1, a2
  n=int(out[64:128],16)
  usdt_out=int(out[128+64*(n-1):128+64*n],16)/1e18
  # also get BNB out
  data2="0xd06ca61f"+amt.to_bytes(32,"big").hex()+(0x40).to_bytes(32,"big").hex()+(2).to_bytes(32,"big").hex()+enc(TOKEN)+enc(WBNB)
  out2=rpc(ROUTER,data2)[2:]
  n2=int(out2[64:128],16)
  bnb_out=int(out2[128+64*(n2-1):128+64*n2],16)/1e18
  expect_bnb=qty*price
  loss=0 if expect_bnb<=0 else max(0,(expect_bnb-bnb_out)/expect_bnb)
  report={"qty":qty,"expectBnb":expect_bnb,"bnbOut":bnb_out,"usdtOut":usdt_out,"lossPct":loss*100,"price":price}
  open("/tmp/aipro-watch/QUOTE_CHECK.json","w").write(json.dumps(report,indent=2))
  print(json.dumps(report))
  if loss > 0.10:
    open("/tmp/aipro-watch/ABORT.json","w").write(json.dumps({"reason":"tax_or_slip_gt_10pct",**report},indent=2))
    raise SystemExit(12)
except SystemExit:
  raise
except Exception as e:
  open("/tmp/aipro-watch/QUOTE_CHECK.json","w").write(json.dumps({"error":str(e)}))
  print("quote check failed",e,"— proceeding with caution flag")
  # do not abort on quote RPC failure; MEV path still used
PY

rm -f /tmp/baw-sell-w{1,2,3,4}.log

if [[ "$ACTION" == "tp_principal" ]]; then
  QTY=$(python3 -c 'print(float("'"$QTY_P"'"))')
  echo "[sell-waiter] tp_principal qty=$QTY"
  GAS=HIGH MEV=true "$SELL_ALL" "$TOKEN" "$QTY" | tee "$OUT/sell-all.out"
else
  echo "[sell-waiter] sl_all full balance"
  GAS=HIGH MEV=true "$SELL_ALL" "$TOKEN" | tee "$OUT/sell-all.out"
fi

python3 - <<'PY'
import json,re
from pathlib import Path
trig=json.load(open("/tmp/aipro-watch/TRIGGER.consumed.json"))
out={"trigger":trig, "action_name":trig.get("action"), "wallets":{}}
for i in range(1,5):
  p=f"/tmp/baw-sell-w{i}.log"
  text=Path(p).read_text() if Path(p).exists() else ""
  hashes=re.findall(r'0x[a-fA-F0-9]{64}', text)
  usdt=re.findall(r'(?:toTokenQty|received|amountOut|USDT)[^\d]*([\d.]+)', text, re.I)
  out["wallets"][f"w{i}"]={"log":text[-4000:], "hashes":hashes[-3:], "usdt_guess":usdt[-3:] if usdt else []}
Path("/tmp/aipro-watch/SELL_RESULT.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
Path("/workspace/pool-watch/aipro/SELL_RESULT.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
print(json.dumps({k:{kk:vv for kk,vv in v.items() if kk!="log"} for k,v in out["wallets"].items()}, indent=2))
print("wrote SELL_RESULT.json")
PY
echo "[sell-waiter] done $(date -Is)"
