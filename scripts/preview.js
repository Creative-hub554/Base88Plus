#!/usr/bin/env node
/**
 * Start the Anybase dev server on the first free port.
 *
 * `next dev` uses port 3000 unless told otherwise, and a second server
 * (another thread, another worktree, a stale process) either collides or
 * silently shifts ports. This wrapper probes ports with a REAL bind —
 * the same check the kernel makes, so it is authoritative on every
 * platform, IPv4 and IPv6 — and starts `next dev` on the first free
 * one. Ad-hoc previews never collide.
 *
 * Note: Next 16 dev servers additionally refuse to run twice for the
 * SAME project directory on ANY port ("Another next dev server is
 * already running", with the other server's PID and URL) — that guard
 * is Next's own and independent of this one. This wrapper covers the
 * remaining collisions: other worktrees, other directories, and
 * PREVIEW_PORT/`--port` overrides that would otherwise crash into
 * an unrelated listener.
 *
 * Usage:
 *   node scripts/preview.js            first free port from 3000 up
 *   node scripts/preview.js --port N   first free port from N up
 *   PREVIEW_PORT=N node scripts/preview.js
 *
 * The child is the server: output streams through, Ctrl+C stops it, and
 * the wrapper exits with the child's code. The chosen port is printed
 * as `PREVIEW_URL=http://localhost:<port>` so callers can scrape it.
 */
'use strict';

const net = require('net');
const { spawn } = require('child_process');

const PROBE_TIMEOUT_MS = 1_000;
const MAX_PORT_TRIES = 20;

function firstPortFrom(argv, env) {
  const flag = argv.indexOf('--port');
  if (flag !== -1 && argv[flag + 1]) return Number.parseInt(argv[flag + 1], 10);
  const inline = argv.find(a => /^--port=\d+$/.test(a));
  if (inline) return Number.parseInt(inline.slice('--port='.length), 10);
  if (env.PREVIEW_PORT) return Number.parseInt(env.PREVIEW_PORT, 10);
  return 3000;
}

/** Resolve true only if THIS process can actually bind the port. */
function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    const done = answer => {
      probe.removeAllListeners('error');
      probe.removeAllListeners('listening');
      probe.close(() => resolve(answer));
    };
    probe.once('error', () => resolve(false));
    probe.once('listening', () => done(true));
    probe.listen(port);
    setTimeout(() => {
      if (probe.listening) done(true);
    }, PROBE_TIMEOUT_MS);
  });
}

async function pickPort(first) {
  for (let port = first; port < first + MAX_PORT_TRIES; port += 1) {
    // sequential probe: stop at the first free port
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port in ${first}..${first + MAX_PORT_TRIES - 1}`);
}

async function main() {
  const first = firstPortFrom(process.argv, process.env);
  if (!Number.isInteger(first) || first < 1 || first > 65535) {
    throw new Error(`bad starting port: ${first}`);
  }

  const nextBin = require.resolve('next/dist/bin/next');
  const port = await pickPort(first);

  console.log(`[preview] port ${port} is free — starting next dev`);
  const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
    stdio: 'inherit',
    env: process.env,
  });

  console.log(`[preview] PREVIEW_URL=http://localhost:${port} (pid ${child.pid})`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : code == null ? 0 : code);
  });
}

main().catch(err => {
  console.error(`[preview] ${err.message}`);
  process.exit(1);
});
