#!/usr/bin/env node
/**
 * BSC pool-open → four-wallet max transfer daemon (1s poll).
 * Usage: node watch-transfer.mjs [--config ./config.json]
 * Env: CONFIG=/path/to/config.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const DEST_HARD = '0xb079101b450e2caeb6df730e3a5a069ae263fc30';

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

function loadConfig() {
  const idx = process.argv.indexOf('--config');
  const path = process.env.CONFIG || (idx >= 0 ? process.argv[idx + 1] : join(__dirname, 'config.json'));
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  cfg.__path = resolve(path);
  cfg.__dir = dirname(cfg.__path);
  cfg.dest = String(cfg.dest || '').toLowerCase();
  cfg.token = String(cfg.token || '').toLowerCase();
  cfg.pair = String(cfg.pair || '').toLowerCase();
  if (cfg.dest !== DEST_HARD) {
    throw new Error(`dest mismatch: expected ${DEST_HARD}, got ${cfg.dest}`);
  }
  return cfg;
}

async function rpcCall(rpc, to, data) {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc err');
  return j.result || '0x';
}

const STABLES = new Set([
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8d0d000ee44948d4c10bf1e9f43f61f9f6bd2b35', // USD1
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
]);

async function getReserves(cfg) {
  let lastErr;
  for (const rpc of cfg.rpcs) {
    try {
      const t0 = ('0x' + (await rpcCall(rpc, cfg.pair, '0x0dfe1681')).slice(-40)).toLowerCase();
      const t1 = ('0x' + (await rpcCall(rpc, cfg.pair, '0xd21220a7')).slice(-40)).toLowerCase();
      const hex = (await rpcCall(rpc, cfg.pair, '0x0902f1ac')).slice(2);
      if (hex.length < 128) throw new Error('bad reserves');
      const r0 = BigInt('0x' + hex.slice(0, 64));
      const r1 = BigInt('0x' + hex.slice(64, 128));
      const wbnbRaw = t0 === WBNB ? r0 : t1 === WBNB ? r1 : 0n;
      const stableRaw =
        STABLES.has(t0) ? r0 : STABLES.has(t1) ? r1 : 0n;
      const wbnb = Number(wbnbRaw) / 1e18;
      const stable = Number(stableRaw) / 1e18;
      const minW = Number(cfg.minWbnb || 0.01);
      const minQ = Number(cfg.minQuote || 0.01);
      const open = wbnb >= minW || stable >= minQ;
      return { open, wbnb, stable, rpc, t0, t1 };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no rpc');
}

function runBaw(cfg, sessionDir, args) {
  return new Promise((resolveP) => {
    const home = join(cfg.__dir, '.runtime-homes', sessionDir.replace(/[\/~]/g, '_'));
    mkdirSync(join(home, '.baw'), { recursive: true });
    const sess = join(expandHome(sessionDir), 'session.json');
    if (!existsSync(sess)) {
      resolveP({ ok: false, code: 2, out: `missing session ${sess}` });
      return;
    }
    copyFileSync(sess, join(home, '.baw', 'session.json'));
    const child = spawn(cfg.bawBin || 'baw', args, {
      env: { ...process.env, HOME: home, PATH: process.env.PATH },
      cwd: home,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolveP({ ok: code === 0, code, out }));
    child.on('error', (e) => resolveP({ ok: false, code: -1, out: String(e) }));
  });
}

async function transferAll(cfg) {
  const argsBase = [
    'wallet',
    'send',
    '--binanceChainId',
    String(cfg.binanceChainId || 56),
    '--max',
    '--tokenAddress',
    cfg.token,
    '--recipient',
    cfg.dest,
    '--gasLevel',
    cfg.gasLevel || 'HIGH',
  ];
  const jobs = (cfg.sessionDirs || []).map(async (dir, i) => {
    const t0 = Date.now();
    const res = await runBaw(cfg, dir, argsBase);
    return { wallet: i + 1, ms: Date.now() - t0, ...res };
  });
  return Promise.all(jobs);
}

function log(line) {
  const s = `${new Date().toISOString()} ${line}`;
  console.log(s);
  try {
    const cfgDir = process.env.__CFG_DIR;
    if (cfgDir) {
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, 'watch.log'), s + '\n', { flag: 'a' });
    }
  } catch {}
}

async function main() {
  const cfg = loadConfig();
  process.env.__CFG_DIR = cfg.__dir;
  const flag = join(cfg.__dir, 'transferred.flag');
  log(`start pair=${cfg.pair} interval=${cfg.intervalMs || 1000}ms dest=${cfg.dest}`);

  if (existsSync(flag) && cfg.once !== false) {
    log('already transferred (flag exists), idle exit. delete transferred.flag to re-arm');
    process.exit(0);
  }
  const arm = join(cfg.__dir, 'armed.flag');
  if (cfg.requireArm !== false && !existsSync(arm)) {
    log('not armed: touch armed.flag then restart. watching disabled until armed');
    // still loop but never transfer — or exit. Exit so systemd can restart after arm.
    process.exit(0);
  }
  if (cfg.dryRun) log('DRY_RUN=1: will detect open but not send');

  let tick = 0;
  for (;;) {
    tick++;
    try {
      const st = await getReserves(cfg);
      if (st.open) {
        log(`POOL OPEN wbnb=${st.wbnb} stable=${st.stable} rpc=${st.rpc} → transfer`);
        if (cfg.dryRun) {
          log('DRY_RUN skip send');
          writeFileSync(flag, new Date().toISOString() + ' dry');
          process.exit(0);
        }
        writeFileSync(flag, new Date().toISOString());
        const results = await transferAll(cfg);
        for (const r of results) {
          log(`w${r.wallet} ok=${r.ok} code=${r.code} ${r.ms}ms\n${(r.out || '').trim().slice(0, 500)}`);
        }
        writeFileSync(join(cfg.__dir, 'last-transfer.json'), JSON.stringify({ ts: new Date().toISOString(), results }, null, 2));
        if (cfg.once !== false) {
          log('done (once=true)');
          process.exit(0);
        }
      } else if (tick % 30 === 0) {
        log(`still closed tick=${tick} wbnb=${st.wbnb} stable=${st.stable}`);
      }
    } catch (e) {
      if (tick % 10 === 0) log(`poll err: ${e.message || e}`);
    }
    await new Promise((r) => setTimeout(r, Number(cfg.intervalMs || 1000)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
