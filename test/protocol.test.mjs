import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve, validateTarget } from '../service/protocol.mjs';
import { signedEnvelope } from '../service/release.mjs';

const directory = mkdtempSync(path.join(tmpdir(), 'ota-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${directory}/key.pem`, '-out', `${directory}/cert.pem`, '-days', '1', '-subj', '/CN=Test'], { stdio: 'ignore' });
const privateKey = readFileSync(`${directory}/key.pem`, 'utf8');
const certificate = readFileSync(`${directory}/cert.pem`, 'utf8');
const target = { channel: 'staging', platform: 'ios', runtimeVersion: 'a'.repeat(40) };
const assetBaseUrl = 'https://assets.example.com';
const manifest = { id: '11111111-1111-4111-8111-111111111111', createdAt: new Date().toISOString(), runtimeVersion: target.runtimeVersion,
  launchAsset: { hash: 'a'.repeat(43), key: 'bundle', url: `${assetBaseUrl}/assets/bundle`, contentType: 'application/javascript' }, assets: [], metadata: {}, extra: {} };
const envelope = () => signedEnvelope('manifest', manifest, privateKey, certificate, target, assetBaseUrl);
const noUpdate = () => signedEnvelope('directive', { type: 'noUpdateAvailable' }, privateKey, certificate, target, assetBaseUrl);
const event = (headers = {}) => ({ requestContext: { http: { method: 'GET' } }, headers: { 'expo-protocol-version': '1', 'expo-platform': 'ios', 'expo-runtime-version': target.runtimeVersion, 'expo-channel-name': 'staging', accept: 'multipart/mixed', 'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"', ...headers } });
const deps = (changes = {}) => ({ certificate, assetBaseUrl, readPointer: async () => ({ releaseId: manifest.id }), readRelease: async () => envelope(), readNoUpdate: async () => noUpdate(), ...changes });

test('signed multipart serves the exact body and lowercase signature part header', async () => {
  const response = await serve(event(), deps());
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /name="manifest"/);
  assert.match(response.body, /expo-signature: sig=/);
  assert.ok(response.body.includes(JSON.stringify(manifest)));
  assert.equal(response.headers['cache-control'], 'no-store');
});
test('supports JSON manifest requests', async () => {
  const response = await serve(event({ accept: 'application/expo+json' }), deps());
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, JSON.stringify(manifest));
  assert.ok(response.headers['expo-signature']);
});
test('returns a signed v1 no-update directive for empty channel or current update', async () => {
  for (const response of [await serve(event(), deps({ readPointer: async () => null })), await serve(event({ 'expo-current-update-id': manifest.id }), deps())]) {
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /name="directive"/);
    assert.match(response.body, /noUpdateAvailable/);
    assert.match(response.body, /expo-signature:/);
  }
});
test('rejects invalid platforms, runtime traversal, channel, protocol and signature request', async () => {
  for (const headers of [{ 'expo-platform': 'web' }, { 'expo-runtime-version': '../../production' }, { 'expo-channel-name': 'unknown' }, { 'expo-protocol-version': '0' }, { 'expo-expect-signature': 'sig, keyid="other"' }, { 'expo-expect-signature': '"bad"' }]) {
    assert.equal((await serve(event(headers), deps())).statusCode, 400);
  }
});
test('never crosses platform, channel or runtime when selecting a release', async () => {
  let routed;
  await serve(event({ 'expo-channel-name': 'production', 'expo-runtime-version': 'b'.repeat(40), 'expo-platform': 'android' }), deps({ readPointer: async (t) => { routed = t; return null; } }));
  assert.deepEqual(routed, { platform: 'android', channel: 'production', runtimeVersion: 'b'.repeat(40) });
  assert.throws(() => validateTarget({ ...target, runtimeVersion: '/' }));
});
test('tampering and target/origin mismatch fail closed', async () => {
  for (const change of [{ body: JSON.stringify({ ...manifest, runtimeVersion: 'b'.repeat(40) }) }, { platform: 'android' }, { assetBaseUrl: 'https://evil.example.com' }, { signature: 'bad' }]) {
    assert.equal((await serve(event(), deps({ readRelease: async () => ({ ...envelope(), ...change }) }))).statusCode, 503);
  }
});
test('serves signed embedded rollback and handles embedded client', async () => {
  const rollback = signedEnvelope('directive', { type: 'rollBackToEmbedded', parameters: { commitTime: new Date().toISOString() } }, privateKey, certificate, target, assetBaseUrl);
  const response = await serve(event(), deps({ readRelease: async () => rollback }));
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /name="directive"/);
  assert.match(response.body, /rollBackToEmbedded/);
  const steady = await serve(event({ 'expo-current-update-id': 'embedded', 'expo-embedded-update-id': 'embedded' }), deps({ readRelease: async () => rollback }));
  assert.equal(steady.statusCode, 200);
  assert.match(steady.body, /noUpdateAvailable/);
});
test('honors unacceptable formats and q=0', async () => {
  assert.equal((await serve(event({ accept: 'text/html' }), deps())).statusCode, 406);
  assert.equal((await serve(event({ accept: 'multipart/mixed;q=0' }), deps())).statusCode, 406);
});
