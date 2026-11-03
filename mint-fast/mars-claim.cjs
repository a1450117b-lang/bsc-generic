#!/usr/bin/env node
/**
 * Mars Nexus claimReferral fast path.
 * Usage: node mars-claim.mjs [--dry] [--wallets=1,2,3]
 *
 * Root cause fix: BAW broadcast gasPrice > eth_gasPrice used in estimate →
 * RandomnessUnavailable (0xd58eba11). Estimate fee at ~8× network gasPrice
 * (clamped to maxRandomnessFee), cap = min(fee*1.2, maxFee), value=cap.
 * Parallel isolated HOME=/tmp/bawhome-wN preview→execute.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const createKeccakHash = require('keccak');

const sel = (s) => '0x' + createKeccakHash('keccak256').update(s).digest('hex').slice(0, 8);
const pad = (n) => BigInt(n).toString(16).padStart(64, '0');
const padAddr = (a) => a.replace(/^0x/i, '').toLowerCase().padStart(64, '0');

const M = process.env.MARS_NFT || '0xC4059D2F9F6F86695896e68F3E73E1e6cC3791c8';
const RPC = process.env.BSC_RPC || 'https://bsc-dataseed.bnbchain.org';
const ALL = [
  { n: 1, addr: '0x0ABABF8eF7A083A580b4662d7e4e39Af32DBbEd1' },
  { n: 2, addr: '0xd7857acc2a935570d14a1c847c9B056eC7071fF2' },
  { n: 3, addr: '0x2DBf34008CEb2Cd771f573D8FF1abEc95b2D777f' },
  { n: 4, addr: '0x1727420C362B89B038869423e33644bcA33bbC8d' },
];

const argv = process.argv.slice(2);
const dry = argv.includes('--dry') || process.env.EXECUTE !== '1';
const wArg = argv.find((a) => a.startsWith('--wallets='));
const want = wArg
  ? wArg.split('=')[1].split(',').map((x) => Number(x.trim())).filter(Boolean)
  : [1, 2, 3, 4];

async function rpc(method, params) {
  const j = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json());
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
async function call(data, extra = {}) {
  return rpc('eth_call', [{ to: M, data, ...extra }, 'latest']);
}

function ensureHome(n) {
  const home = `/tmp/bawhome-w${n}`;
  fs.mkdirSync(`${home}/.baw`, { recursive: true });
  spawnSync('bash', ['-lc', `cp -a ~/.baw/. ${home}/.baw/ 2>/dev/null || true`]);
  const sess = `${process.env.HOME || '/home/box'}/.baw-wallets/w${n}/session.json`;
  if (fs.existsSync(sess)) {
    fs.copyFileSync(sess, `${home}/.baw/session.json`);
  }
  return home;
}

function baw(home, args) {
  return spawnSync('baw', args, {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 120000,
  });
}

(async () => {
  const t0 = Date.now();
  const [gpH, maxFeeH] = await Promise.all([
    rpc('eth_gasPrice', []),
    call(sel('maxRandomnessFee()')),
  ]);
  const gp = BigInt(gpH);
  let estGp = gp * 8n;
  if (estGp < 300000000n) estGp = 300000000n;
  const maxFee = BigInt(maxFeeH);
  let fee = BigInt(await call(sel('estimateRandomnessFee(uint256)') + pad(estGp)));
  if (fee > maxFee) {
    let lo = gp,
      hi = estGp;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2n;
      const f = BigInt(await call(sel('estimateRandomnessFee(uint256)') + pad(mid)));
      if (f <= maxFee) {
        lo = mid;
        fee = f;
      } else hi = mid;
    }
    estGp = lo;
  }
  let cap = (fee * 120n) / 100n;
  if (cap > maxFee) cap = maxFee;
  if (cap < fee) throw new Error('cap<fee');
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 280);
  const data = sel('claimReferral(uint256,uint256)') + pad(cap) + pad(deadline);
  const value = '0x' + cap.toString(16);

  const wallets = ALL.filter((w) => want.includes(w.n));
  const preRows = await Promise.all(
    wallets.map(async (w) => {
      const q = await call(sel('quote(address)') + padAddr(w.addr));
      const key = '0x' + q.slice(2, 66);
      const [qualifiedH, claimedH, balH] = await Promise.all([
        call(sel('qualifiedReferrals(bytes32)') + key.slice(2).padStart(64, '0')),
        call(sel('referralClaimed(bytes32)') + key.slice(2).padStart(64, '0')),
        call('0x70a08231' + padAddr(w.addr)),
      ]);
      const qualified = BigInt(qualifiedH);
      const claimed = BigInt(claimedH);
      const bal = BigInt(balH);
      let simOk = false,
        simErr = null;
      if (qualified > 0n && claimed === 0n) {
        try {
          await rpc('eth_call', [
            {
              from: w.addr,
              to: M,
              data,
              value,
              gas: '0x7a120',
              gasPrice: '0x' + estGp.toString(16),
            },
            'latest',
          ]);
          simOk = true;
        } catch (e) {
          simErr = String(e.message).slice(0, 180);
        }
      }
      return { w, qualified, claimed, bal, simOk, simErr };
    }),
  );
  const eligible = [];
  for (const row of preRows) {
    console.log(
      'PRE',
      JSON.stringify({
        w: row.w.n,
        addr: row.w.addr,
        qualified: row.qualified.toString(),
        claimed: row.claimed.toString(),
        nftBal: row.bal.toString(),
        simOk: row.simOk,
        simErr: row.simErr,
      }),
    );
    if (row.simOk) eligible.push(row.w);
  }

  const plan = {
    nft: M,
    gp: gp.toString(),
    estGp: estGp.toString(),
    fee: fee.toString(),
    cap: cap.toString(),
    deadline: deadline.toString(),
    value,
    data,
    dry,
    eligible: eligible.map((w) => w.n),
  };
  fs.writeFileSync('/tmp/mars-claim-plan.json', JSON.stringify(plan, null, 2));
  console.log('PLAN', JSON.stringify(plan));

  if (dry) {
    console.log('DRY elapsed_s', ((Date.now() - t0) / 1000).toFixed(1));
    process.exit(0);
  }
  if (!eligible.length) {
    console.log('NONE_ELIGIBLE elapsed_s', ((Date.now() - t0) / 1000).toFixed(1));
    process.exit(0);
  }

  const results = await Promise.all(
    eligible.map(
      (w) =>
        new Promise((resolve) => {
          const home = ensureHome(w.n);
          const prev = baw(home, [
            'contract-call',
            'preview',
            '--binanceChainId',
            '56',
            '--from',
            w.addr,
            '--to',
            M,
            '--value',
            value,
            '--inputData',
            data,
            '--gasLimit',
            '500000',
            '--json',
          ]);
          let rid = null,
            preview = null;
          try {
            preview = JSON.parse(prev.stdout || '{}');
            rid = preview?.data?.requestId;
          } catch {}
          fs.writeFileSync(`/tmp/mars-claim-w${w.n}-prev.json`, prev.stdout || '');
          let ex = null;
          if (preview?.success && rid) {
            const er = baw(home, ['contract-call', 'execute', '--requestId', rid, '--json']);
            try {
              ex = JSON.parse(er.stdout || '{}');
            } catch {
              ex = { raw: er.stdout };
            }
            fs.writeFileSync(`/tmp/mars-claim-w${w.n}-ex.json`, er.stdout || '');
          }
          resolve({
            w: w.n,
            addr: w.addr,
            rid,
            previewOk: !!preview?.success,
            txHash: ex?.data?.txHash || null,
            ex,
          });
        }),
    ),
  );

  // wait receipts briefly
  await new Promise((r) => setTimeout(r, 6000));
  for (const r of results) {
    if (!r.txHash) {
      console.log('RESULT', JSON.stringify({ ...r, status: null }));
      continue;
    }
    let receipt = null;
    for (let i = 0; i < 15; i++) {
      receipt = await rpc('eth_getTransactionReceipt', [r.txHash]);
      if (receipt) break;
      await new Promise((x) => setTimeout(x, 1500));
    }
    const q = await call(sel('quote(address)') + padAddr(r.addr));
    const key = '0x' + q.slice(2, 66);
    const claimed = BigInt(
      await call(sel('referralClaimed(bytes32)') + key.slice(2).padStart(64, '0')),
    );
    const bal = BigInt(await call('0x70a08231' + padAddr(r.addr)));
    console.log(
      'RESULT',
      JSON.stringify({
        w: r.w,
        txHash: r.txHash,
        status: receipt?.status,
        claimed: claimed.toString(),
        nftBal: bal.toString(),
      }),
    );
  }
  fs.writeFileSync('/tmp/mars-claim-results.json', JSON.stringify(results, null, 2));
  console.log('DONE elapsed_s', ((Date.now() - t0) / 1000).toFixed(1));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
