import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, verify, X509Certificate } from 'node:crypto';
import { prepareRelease } from '../service/release.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'ota-export-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${root}/key.pem`, '-out', `${root}/cert.pem`, '-days', '1', '-subj', '/CN=Test'], { stdio: 'ignore' });
const privateKey = await readFile(`${root}/key.pem`, 'utf8');
const certificate = await readFile(`${root}/cert.pem`, 'utf8');
await writeFile(`${root}/bundle.js`, 'console.log("ota")');
await writeFile(`${root}/image`, 'image bytes');
const metadata = { fileMetadata: { android: { bundle: 'bundle.js', assets: [{ path: 'image', ext: 'png' }] } } };
await writeFile(`${root}/metadata.json`, JSON.stringify(metadata));
const options = { exportDirectory: root, expoConfig: { version: '1.1.2' }, target: { platform: 'android', channel: 'staging', runtimeVersion: 'a'.repeat(40) }, privateKey, certificate, assetBaseUrl: 'https://assets.example.com', sourceSha: 'b'.repeat(40) };
test('export assets have correct hashes, extensions, signing and immutable keys', async () => {
  const { envelope, uploads } = await prepareRelease(options);
  const manifest = JSON.parse(envelope.body);
  assert.equal(uploads.size, 2);
  assert.equal(manifest.assets[0].fileExtension, '.png');
  assert.equal(manifest.launchAsset.fileExtension, undefined);
  for (const [key, a] of uploads) {
    assert.equal(a.hash, createHash('sha256').update(a.bytes).digest('base64url'));
    assert.equal(key, `assets/${a.hash}`);
  }
  assert.ok(verify('RSA-SHA256', Buffer.from(envelope.body), new X509Certificate(certificate).publicKey, Buffer.from(envelope.signature, 'base64')));
});
test('missing native platform and invalid source SHA fail', async () => {
  await assert.rejects(prepareRelease({ ...options, target: { ...options.target, platform: 'ios' } }), /Missing platform/);
  await assert.rejects(prepareRelease({ ...options, sourceSha: 'HEAD' }), /commit SHA/);
});
test('export cannot reference a file outside its directory', async () => {
  const external = await mkdtemp(path.join(tmpdir(), 'ota-external-'));
  await writeFile(`${external}/file`, 'external');
  await symlink(`${external}/file`, `${root}/escape`);
  await writeFile(`${root}/metadata.json`, JSON.stringify({ fileMetadata: { android: { bundle: 'escape', assets: [] } } }));
  await assert.rejects(prepareRelease(options), /escapes directory/);
});
