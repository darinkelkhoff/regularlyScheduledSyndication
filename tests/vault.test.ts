import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceVault } from '../src/security/source-vault.ts';
const secret = new Uint8Array(32).fill(7);
test('source URLs are encrypted with unique IVs and bound to their owner', async () => {
  const vault = await SourceVault.create(secret);
  const url = 'https://member:private@example.com/feed?token=secret';
  const a = await vault.seal('alice', url);
  const b = await vault.seal('alice', url);
  assert.notEqual(a, b);
  assert.ok(!a.includes(url));
  assert.equal(await vault.open('alice', a), url);
  await assert.rejects(vault.open('bob', a));
  await assert.rejects(vault.open('alice', a.slice(0, -4) + 'AAAA'));
  const other = await SourceVault.create(new Uint8Array(32).fill(8));
  await assert.rejects(other.open('alice', a));
});
test('URL fingerprints are stable, keyed and owner-specific', async () => {
  const vault = await SourceVault.create(secret);
  assert.equal(await vault.fingerprint('alice', 'https://example.com'), await vault.fingerprint('alice', 'https://example.com'));
  assert.notEqual(await vault.fingerprint('alice', 'https://example.com'), await vault.fingerprint('bob', 'https://example.com'));
  await assert.rejects(SourceVault.create(new Uint8Array(16)));
});
