# bsc-mint-skill progress (Asia/Shanghai)
- [x] read existing tooling (mint-fast/check.mjs, SKILL.md, progress-*.md)
- [x] lib/util, rpc (round-robin+failover, batch; logs via publicnode since dataseed rejects getLogs), sigdb (builtin+openchain/4byte cache), fingerprint (proxy slots, EIP-1167, PUSH4/PUSH20 scan, norm hash), discovery, history, evm (decode/revert/slots/simulateV1), mintfn (templates+generic builder)
- [x] risk.mjs + precheck.mjs orchestrator (bbforge first run OK ~11s)
- [x] history seed (15 projects) + history.mjs CLI
- [x] tests: bbforge cold 7.8s / matched 5.3s, BNBCAT, USDT(not-mint), pair(not-mint), SAFUAI(site 503→history), binanciansai, buildnbuild, kda, fireball, rushai(needs_ai), grokagent(jaccard match)
- [x] SKILL.md draft written; final regression tests/run-all.sh all 10 targets OK (2.5–6s)
Findings: eth_simulateV1 works on bsc-dataseed (logs+traceTransfers). sourcify v2 has bbforge Core verified (ABI). dataseed/defibit/ninicoin: eth_getLogs "limit exceeded" any range; publicnode ok 5000 blocks; drpc 429 often.
