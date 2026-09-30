import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { signedEnvelope } from '../service/release.mjs';
import { activateRelease } from '../service/publication.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'ota-publication-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '1', '-subj', '/CN=Test'], { stdio: 'ignore' });
const privateKey = readFileSync(`${dir}/key.pem`, 'utf8');
const certificate = readFileSync(`${dir}/cert.pem`, 'utf8');
const id = '11111111-1111-4111-8111-111111111111';
const assetBaseUrl = 'https://assets.example.com';
const target = { platform: 'ios', channel: 'production', runtimeVersion: 'a'.repeat(40) };
const hash = 'a'.repeat(43);
const manifest = { id, runtimeVersion: target.runtimeVersion, createdAt: new Date().toISOString(), assets: [], metadata: {}, extra: {}, launchAsset: { hash, key: 'bundle', url: `${assetBaseUrl}/assets/${hash}`, contentType: 'application/javascript' } };
const envelope = { ...signedEnvelope('manifest', manifest, privateKey, certificate, target, assetBaseUrl), environment: 'production' };
const make = ({ missingAsset = false, testedHash = createHash('sha256').update(envelope.body).digest('hex'), conflict = false, previous = null } = {}) => {
  let activated = false;
  let etag;
  return {
    options: { id, target, certificate, assetBaseUrl,
      read: async (key) => key.startsWith('tested/') ? { data: { bodyHash: testedHash } } : key.startsWith('channels/') ? previous : { data: envelope },
      headAsset: async () => ({ Metadata: { sha256: missingAsset ? 'wrong' : hash } }),
      writePointer: async (_key, _value, match) => { etag = match; if (conflict) throw new Error('412 conditional conflict'); activated = true; },
    },
    activated: () => activated, etag: () => etag,
  };
};
test('production activates only a verified complete tested release', async () => {
  const fixture = make();
  await activateRelease(fixture.options);
  assert.equal(fixture.activated(), true);
});
test('missing or corrupted assets leave the active pointer unchanged', async () => {
  const fixture = make({ missingAsset: true });
  await assert.rejects(activateRelease(fixture.options), /asset/);
  assert.equal(fixture.activated(), false);
});
test('changed or untested manifest cannot be promoted', async () => {
  const fixture = make({ testedHash: 'wrong' });
  await assert.rejects(activateRelease(fixture.options), /not been marked tested/);
  assert.equal(fixture.activated(), false);
});
test('conditional pointer conflict fails instead of overwriting another publication', async () => {
  const fixture = make({ conflict: true });
  await assert.rejects(activateRelease(fixture.options), /conditional conflict/);
  assert.equal(fixture.activated(), false);
});
test('older releases cannot silently be promoted as a rollback', async () => {
  const fixture = make({ previous: { data: { releaseId: id }, etag: 'active-etag' } });
  await assert.rejects(activateRelease(fixture.options), /must be newer/);
  assert.equal(fixture.activated(), false);
});
