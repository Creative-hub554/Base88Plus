/**
 * Pure-Node libsodium sealed box (crypto_box_seal) — the exact construction
 * GitHub's Actions-secrets endpoint decrypts server-side.
 *
 * Wire format: ephemeralPub(32) || crypto_box(msg, nonce, recipientPub, ephSec)
 * where nonce = crypto_generichash(ephemeralPub || recipientPub, 24) — i.e.
 * BLAKE2b-192 over the 64 concatenated key bytes (libsodium's actual
 * crypto_box_seal derivation — CONFIRMED against stdlib blake2b digest_size=24
 * and PyNaCl's SealedBox, not from memory: this morning's "first 24 raw
 * bytes" reading produced the "bad nonce size" crash and a GitHub 422
 * "improperly encrypted secret"; the hash derivation is what decrypts).
 * tweetnacl ships neither the hash nor a sealed-box mode, hence blakejs.
 *
 * Ciphertext overhead: 32 (ephemeral pub) + 16 (box MAC) = 48 bytes.
 *
 * Cross-library proof chain (2026-09-29): blakejs KAT == stdlib
 * hashlib.blake2b(digest_size=24) == libsodium generichash; and a box sealed
 * by THIS module opens via the REAL recipient secret key (self-test + vitest).
 */
'use strict';

import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEALED_OVERHEAD = 48; // 32-byte ephemeral pub + 16-byte MAC

/**
 * Seal `plaintext` (Uint8Array | Buffer | string) to a base64 repo public key.
 * Returns the base64 `encrypted_value` for PUT /repos/{o}/{r}/actions/secrets/{NAME}.
 */
export function seal(plaintext, repoPubKeyB64) {
  // Copy into a REAL Uint8Array: tweetnacl tag-checks its inputs and Buffer
  // instances from another realm (vitest workers) fail that check.
  const raw = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const msg = new Uint8Array(raw);
  const recipientPub = new Uint8Array(Buffer.from(repoPubKeyB64, 'base64'));
  if (recipientPub.length !== 32) {
    throw new Error(`repo public key must decode to 32 bytes, got ${recipientPub.length}`);
  }
  const eph = nacl.box.keyPair();
  // nonce = BLAKE2b-192(ephPub || recipientPub) — libsodium crypto_box_seal
  const both = new Uint8Array(64);
  both.set(eph.publicKey, 0);
  both.set(recipientPub, 32);
  const nonce = new Uint8Array(blake2b(both, null, 24));
  const boxed = nacl.box(msg, nonce, recipientPub, eph.secretKey);
  if (!boxed) throw new Error('nacl.box failed');
  return Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(boxed)]).toString('base64');
}

/**
 * Open a sealed box with the recipient's secret key — used by the self-test to
 * prove this module's output matches what libsodium would decrypt. Never used
 * on the rotation path.
 */
export function openSealed(sealedWithEph, recipientPubBytes, recipientSecBytes) {
  const buf = typeof sealedWithEph === 'string' ? Buffer.from(sealedWithEph, 'base64') : Buffer.from(sealedWithEph);
  const ephPub = new Uint8Array(buf.subarray(0, 32));
  const boxed = new Uint8Array(buf.subarray(32));
  const both = new Uint8Array(64);
  both.set(ephPub, 0);
  both.set(recipientPubBytes, 32);
  const nonce = new Uint8Array(blake2b(both, null, 24));
  return nacl.box.open(boxed, nonce, ephPub, recipientSecBytes);
}

/** CLI: self-test with a fresh ephemeral keypair (exit 0/1). */
export function selfTest() {
  const pair = nacl.box.keyPair();
  const msg = Buffer.from('rotate-sealed-box-self-test 2026-09-29 \xf0\x9f\x94\x90');
  const pubB64 = Buffer.from(pair.publicKey).toString('base64');
  const sealedB64 = seal(msg, pubB64);
  const sealed = Buffer.from(sealedB64, 'base64');
  if (sealed.length !== msg.length + SEALED_OVERHEAD) {
    console.error(`✗ ciphertext length ${sealed.length} != plaintext ${msg.length} + ${SEALED_OVERHEAD}`);
    return false;
  }
  const opened = openSealed(sealedB64, pair.publicKey, pair.secretKey);
  if (!opened || !Buffer.from(opened).equals(msg)) {
    console.error('✗ round-trip mismatch — construction does NOT match libsodium sealed box');
    return false;
  }
  console.log('✓ sealed-box round-trip via real recipient secret key (libsodium wire format)');
  console.log(`✓ ciphertext overhead exactly ${SEALED_OVERHEAD} bytes`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(selfTest() ? 0 : 1);
}
