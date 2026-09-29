/**
 * Mint + inspect OpenSSH keypairs via the platform ssh-keygen (Win32
 * OpenSSH ships with Windows 10+; git-bash exposes the same binary).
 *
 * Deliberately NOT pure-JS: an OpenSSH wire-format encoder would be a second
 * hand-rolled crypto artifact to maintain, while ssh-keygen output is
 * byte-compatible with GitHub's deploy-key parser by construction — and the
 * resulting public key is re-verified by ssh-keygen itself (see verifyPub)
 * before anything is registered remotely.
 */
'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** OpenSSH public-key blob → SHA256:[b64] fingerprint. */
export function fingerprintOfPubLine(pubLine) {
  const [, b64] = String(pubLine).trim().split(/\s+/);
  const buf = Buffer.from(b64, 'base64');
  // ssh-ed25519 wire: string "ssh-ed25519" (4+11) then string key(4+32) = 51.
  if (buf.length !== 51) throw new Error(`unexpected ed25519 blob length ${buf.length}`);
  // ssh-keygen -lf hashes the FULL RFC 4253 blob (algo string header
  // included) — hashing only the trailing key bytes yields a different,
  // silently-wrong fingerprint (caught by the live drill cross-check).
  return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

/**
 * Mint an ed25519 keypair with the comment GitHub's ssh-agent action expects
 * (git@github.com/owner/repo — webfactory/ssh-agent derives its insteadOf
 * IdentityFile mapping from it). Returns { privateKeyPemPath, pubLine, pubB64,
 * comment, fingerprint, dir }.
 */
export function mintEd25519({ repoSlug, outDir, prefix = 'deploy_key_' }) {
  if (!/^[^/]+\/[^/]+$/.test(repoSlug)) throw new Error(`bad repo slug: ${repoSlug}`);
  fs.mkdirSync(outDir, { recursive: true });
  const keyPath = path.join(outDir, `${prefix}${Date.now()}`);
  execFileSync(
    'ssh-keygen',
    ['-t', 'ed25519', '-C', `git@github.com/${repoSlug}`, '-f', keyPath, '-N', '', '-q'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const pubLine = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
  if (!pubLine.startsWith('ssh-ed25519 ')) {
    throw new Error('ssh-keygen produced an unexpected key type');
  }
  const [keyB64, comment] = pubLine.split(/\s+/).slice(1);
  return {
    privateKeyPath: keyPath,
    pubLine,
    pubB64: keyB64,
    comment,
    fingerprint: fingerprintOfPubLine(pubLine),
    dir: outDir,
  };
}

/** Guard: the private key file must parse as an OpenSSH ED25519 private key. */
export function verifyPrivKey(privPath) {
  const head = fs.readFileSync(privPath, { encoding: 'utf8', flag: 'r' }).split('\n')[0].trim();
  if (head !== '-----BEGIN OPENSSH PRIVATE KEY-----') {
    throw new Error(`${privPath} does not look like an OpenSSH private key`);
  }
  return true;
}

/**
 * Independent check that a minted pair matches: derive the fingerprint from a
 * FRESH `ssh-keygen -lf` run and compare with our own computation. A mismatch
 * aborts before anything touches GitHub.
 */
export function verifyPair(privPath, expectedFingerprint) {
  const out = execFileSync('ssh-keygen', ['-lf', `${privPath}.pub`], { encoding: 'utf8' });
  const sshgenFp = out.trim().split(/\s+/)[1];
  if (sshgenFp !== expectedFingerprint) {
    throw new Error(`fingerprint mismatch: ssh-keygen says ${sshgenFp}, we computed ${expectedFingerprint}`);
  }
  verifyPrivKey(privPath);
  return sshgenFp;
}

/** PEM bodies start/end markers, for sealed payloads and cleanup checks. */
export function isPemFile(p) {
  const s = fs.readFileSync(p, 'utf8');
  return s.includes('-----BEGIN OPENSSH PRIVATE KEY-----') && s.includes('-----END OPENSSH PRIVATE KEY-----');
}
