#!/usr/bin/env bash
# Regression: run precheck on fixed targets and print a summary table (read-only).
cd "$(dirname "$0")/.."
T=("https://bbforge.si/" "https://bbforge.si/" "0x7FcD981A1E48b3fB488C2E21D987156b2A4df48a" "0x55d398326f99059fF775485246999027B3197955" "https://safuai.fun/" "https://binanciansai.meme/project/0x0733bcf81eb7890b91e29938503d154a051c5144" "https://buildnbuild.xyz/#mint" "https://kda.life/" "https://fb.fireball.here.now/" "0x7e293F99D738a25c528f457224815506d7Bf7290")
EXTRA=("--cold --no-history-write" "" "" "" "" "" "" "" "" "--no-history-write")
for i in "${!T[@]}"; do
  timeout 90 node precheck.mjs "${T[$i]}" --json ${EXTRA[$i]} > /tmp/pc-$i.json 2>/dev/null
  node -e '
const o=JSON.parse(require("fs").readFileSync(process.argv[1]));const t=process.argv[2]+" "+process.argv[3];
const m=o.mint?o.mint.sig.slice(0,40):"-";const p=o.price?`${o.price.unit} ${o.price.payToken}`:"-";
const st=o.verdict||((o.open&&o.open.summary)||"").slice(0,40)+` sim${o.simOk}/4`;
console.log([t.slice(0,48),(o.mintContract||"-").slice(0,10),m,p,st,o.historyMatch?o.historyMatch.kind+"@"+o.historyMatch.similarity:"none",o.needs_ai_analysis?"AI":"",o.timing.total+"ms"].join(" | "))' /tmp/pc-$i.json "${T[$i]}" "${EXTRA[$i]}"
done
