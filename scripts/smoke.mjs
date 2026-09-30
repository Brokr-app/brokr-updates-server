import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID, verify, X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseDictionary } from 'structured-headers';
import { prepareRelease, signedEnvelope } from '../service/release.mjs';

// Explicit administrator-run deployment smoke test. This runtime cannot match an actual build.
const outputs = JSON.parse(await readFile('deployment.json', 'utf8')).BrokrUpdates;
const certificate = await readFile('certs/certificate.pem', 'utf8');
const privateKey = await readFile(process.env.OTA_TEST_PRIVATE_KEY_PATH, 'utf8');
const dir = await mkdtemp(path.join(tmpdir(), 'ota-live-smoke-'));
await writeFile(`${dir}/bundle.js`, '/* synthetic OTA protocol smoke test */');
await writeFile(`${dir}/metadata.json`, JSON.stringify({ fileMetadata: { android: { bundle: 'bundle.js', assets: [] } } }));
const target = { channel: 'staging', platform: 'android', runtimeVersion: createHash('sha1').update(`smoke-${randomUUID()}`).digest('hex') };
const s3 = new S3Client({ region: 'eu-north-1' });
const bucket = outputs.BucketName;
const put = (key, data) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(data), ContentType: 'application/json', CacheControl: 'no-store' }));
const pointerKey = `channels/staging/android/${target.runtimeVersion}.json`;
const request = (overrides = {}) => fetch(outputs.ManifestUrl, { headers: {
  'expo-protocol-version': '1', 'expo-platform': 'android', 'expo-runtime-version': target.runtimeVersion,
  'expo-channel-name': 'staging', accept: 'multipart/mixed', 'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"', ...overrides,
} });
const verifyPart = async (response, name, expected) => {
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes(`name="${name}"`));
  const signature = parseDictionary(text.match(/expo-signature: ([^\r\n]+)/)[1]).get('sig')[0];
  assert.ok(text.includes(expected));
  assert.ok(verify('RSA-SHA256', Buffer.from(expected), new X509Certificate(certificate).publicKey, Buffer.from(signature, 'base64')));
};
try {
  const noUpdate = signedEnvelope('directive', { type: 'noUpdateAvailable' }, privateKey, certificate, target);
  await put(`directives/staging/android/${target.runtimeVersion}.json`, noUpdate);
  await verifyPart(await request(), 'directive', noUpdate.body);
  const { envelope, uploads } = await prepareRelease({ exportDirectory: dir, expoConfig: {}, target, privateKey, certificate, assetBaseUrl: outputs.AssetBaseUrl, sourceSha: 'a'.repeat(40) });
  for (const [key, asset] of uploads) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: asset.bytes, ContentType: asset.contentType, Metadata: { sha256: asset.hash }, CacheControl: 'public, max-age=31536000, immutable', IfNoneMatch: '*' })).catch((e) => { if (e.$metadata?.httpStatusCode !== 412) throw e; });
  const id = JSON.parse(envelope.body).id;
  await put(`releases/staging/${id}/android.json`, envelope);
  await put(pointerKey, { releaseId: id });
  await verifyPart(await request(), 'manifest', envelope.body);
  const manifest = JSON.parse(envelope.body);
  const asset = await fetch(manifest.launchAsset.url);
  assert.equal(asset.status, 200);
  assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('base64url'), manifest.launchAsset.hash);
  await verifyPart(await request({ 'expo-current-update-id': id }), 'directive', noUpdate.body);
  assert.equal((await request({ 'expo-channel-name': 'production' })).status, 503);
  assert.equal((await request({ 'expo-platform': 'ios' })).status, 503);
  assert.equal((await request({ 'expo-runtime-version': 'b'.repeat(40) })).status, 503);
  assert.equal((await fetch(`${outputs.AssetBaseUrl}/config/service.json`)).status, 404);
  const rollback = signedEnvelope('directive', { type: 'rollBackToEmbedded', parameters: { commitTime: new Date().toISOString() } }, privateKey, certificate, target, outputs.AssetBaseUrl);
  const rollbackId = randomUUID();
  await put(`releases/staging/${rollbackId}/android.json`, rollback);
  await put(pointerKey, { releaseId: rollbackId });
  await verifyPart(await request(), 'directive', rollback.body);
  console.log('Live signed manifest, CDN asset hash, no-update, channel/platform/runtime isolation, private-path protection and rollback verified.');
} finally {
  // Remove only this test's randomly generated active pointer. Retain immutable assets/envelopes.
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: pointerKey }));
}
