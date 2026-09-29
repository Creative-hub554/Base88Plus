/**
 * Offline tests for the rotation crypto + deploy-key state machine.
 * No network: sealed-box is proven by round-trip through a REAL recipient
 * keypair (the only honest compat proof for the libsodium wire format), and
 * the API discovery logic through injected fixtures.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { seal, openSealed, SEALED_OVERHEAD } from '../scripts/rotation/sealed-box.mjs';
import { fingerprintOfPubLine } from '../scripts/rotation/ssh-keygen.mjs';
import { discover, KEY_TITLE_PREFIX, SECRET_NAME } from '../scripts/rotation/deploy-key.mjs';

type Json = Record<string, unknown>;
interface ApiResult { code: number; json: Json | Array<Json> | null; text: string }
type Api = (p: string, method?: string, body?: Json) => Promise<ApiResult>;

describe('sealed-box (libsodium crypto_box_seal wire format)', () => {
  it('round-trips through a real recipient keypair', () => {
    const pair = nacl.box.keyPair();
    const msg = new TextEncoder().encode('DEPLOY_KEY_PEM payload ✓');
    const sealedB64 = seal(msg, Buffer.from(pair.publicKey).toString('base64'));
    const opened = openSealed(sealedB64, pair.publicKey, pair.secretKey)!;
    expect(Buffer.from(opened).equals(Buffer.from(msg))).toBe(true);
  });

  it('adds exactly 48 bytes of overhead (32 eph pub + 16 MAC)', () => {
    const pair = nacl.box.keyPair();
    const msg = new TextEncoder().encode('x'.repeat(100));
    const sealed = Buffer.from(seal(msg, Buffer.from(pair.publicKey).toString('base64')), 'base64');
    expect(sealed.length).toBe(msg.length + SEALED_OVERHEAD);
    expect(SEALED_OVERHEAD).toBe(48);
  });

  it('accepts empty payloads', () => {
    const pair = nacl.box.keyPair();
    const sealedB64 = seal(new Uint8Array(0), Buffer.from(pair.publicKey).toString('base64'));
    expect(openSealed(sealedB64, pair.publicKey, pair.secretKey)).toBeTruthy();
  });

  it('rejects repo public keys that are not 32 bytes', () => {
    const short = Buffer.from('too-short');
    expect(() => seal('m', short.toString('base64'))).toThrow(/32 bytes/);
  });

  it('cannot be opened with the wrong secret key', () => {
    const a = nacl.box.keyPair();
    const b = nacl.box.keyPair();
    const sealedB64 = seal('secret', Buffer.from(a.publicKey).toString('base64'));
    expect(openSealed(sealedB64, a.publicKey, b.secretKey)).toBeFalsy();
  });
});

describe('ed25519 public-key wire format', () => {
  it('derives the SHA256 fingerprint from an ssh-ed25519 pub line', () => {
    // Build the OpenSSH blob by hand: string "ssh-ed25519" + string key(32).
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i;
    const algo = new TextEncoder().encode('ssh-ed25519');
    const blob = Buffer.concat([
      Buffer.from([0, 0, 0, 11]), algo,
      Buffer.from([0, 0, 0, 32]), Buffer.from(key),
    ]);
    const pubLine = `ssh-ed25519 ${blob.toString('base64')} git@github.com/o/r`;
    const fp = fingerprintOfPubLine(pubLine);
    // ssh-keygen -lf hashes the FULL blob — assert against that directly.
    const expected = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
    expect(fp).toBe(expected);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fp.endsWith('=')).toBe(false); // ssh-keygen strips padding
  });

  it('rejects blobs with unexpected length', () => {
    expect(() => fingerprintOfPubLine('ssh-ed25519 AAAA git@x')).toThrow(/blob length/);
  });
});

describe('deploy-key discovery (fixture api, no network)', () => {
  const fullRuleset = (over: Json = {}): Json => ({
    id: 77,
    name: 'main-protection',
    enforcement: 'active',
    target: 'branch',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'deletion' }],
    bypass_actors: [
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      { actor_id: 1, actor_type: 'DeployKey', bypass_mode: 'always' }, // the healthy world
    ],
    ...over,
  });

  function fixtureApi(rulesetDetail: Json = fullRuleset()) {
    const calls: string[] = [];
    return {
      calls,
      api: (async (p: string): Promise<ApiResult> => {
        calls.push(p);
        if (p.startsWith('/repos/o/r/keys')) {
          return { code: 200, text: '', json: [
            { id: 1, title: `${KEY_TITLE_PREFIX} (v3, 2026-09-29-ab)`, read_only: false },
            { id: 2, title: 'some other key', read_only: true },
            { id: 3, title: `${KEY_TITLE_PREFIX} (v2, older)`, read_only: false },
          ] as unknown as Json };
        }
        if (p === '/repos/o/r/rulesets?per_page=100') {
          return { code: 200, text: '', json: [
            { id: 77, enforcement: 'active', target: 'branch' },
            { id: 88, enforcement: 'active', target: 'push' },      // wrong target
            { id: 99, enforcement: 'evaluate', target: 'branch' },  // not enforced
          ] as unknown as Json };
        }
        if (p === '/repos/o/r/rulesets/77') return { code: 200, text: '', json: rulesetDetail };
        if (p.startsWith('/repos/o/r/actions/secrets?')) {
          return { code: 200, text: '', json: { total_count: 2, secrets: [{ name: SECRET_NAME }, { name: 'OTHER' }] } as unknown as Json };
        }
        return { code: 404, text: '', json: null };
      }) as Api,
    };
  }

  it('classifies writers, cron keys, the governing ruleset, and the secret', async () => {
    const f = fixtureApi();
    const d = await discover(f.api as Parameters<typeof discover>[0], 'o/r');
    expect(d.writers.map((k: { id: number }) => k.id)).toEqual([1, 3]);
    expect(d.cronKeys.map((k: { id: number }) => k.id)).toEqual([1, 3]);
    expect(d.writerWithoutCronTitle).toEqual([]);
    expect((d.ruleset as Json | null)?.id).toBe(77); // push-target + evaluate rulesets skipped
    expect(d.rulesetBypassKeys).toHaveLength(1);
    expect(d.secret).toBe(true);
    // per-ruleset detail fetch happened (list omits bypass_actors)
    expect(f.calls).toContain('/repos/o/r/rulesets/77');
  });

  it('treats a non-governing ruleset as no ruleset', async () => {
    const f2 = fixtureApi(fullRuleset({
      conditions: { ref_name: { include: ['refs/heads/dev'], exclude: [] } },
    }));
    const d2 = await discover(f2.api as Parameters<typeof discover>[0], 'o/r');
    expect(d2.ruleset).toBeNull();
    expect(d2.rulesetBypassKeys).toEqual([]);
  });

  it('survives a ruleset list with nothing active', async () => {
    const f = fixtureApi();
    const orig = f.api;
    f.api = (async (p: string, m?: string) => {
      if (p.startsWith('/repos/o/r/rulesets?')) return { code: 200, text: '', json: [] };
      return (orig as Api)(p, m);
    }) as Api;
    const d = await discover(f.api as Parameters<typeof discover>[0], 'o/r');
    expect(d.ruleset).toBeNull();
    expect(d.secret).toBe(true);
  });
});
