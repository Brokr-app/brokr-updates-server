import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { prepareRelease, signedEnvelope } from '../service/release.mjs';
import { validateTarget, validateEnvelope, targetKey } from '../service/protocol.mjs';
import { activateRelease } from '../service/publication.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Expected --option value');
  options[args[i].slice(2)] = args[i + 1];
}
const bucket = process.env.OTA_BUCKET;
const assetBaseUrl = process.env.OTA_ASSET_BASE_URL;
if (!bucket || !assetBaseUrl) throw new Error('Missing OTA_BUCKET / OTA_ASSET_BASE_URL');
const s3 = new S3Client({});
const target = { channel: options.channel, platform: options.platform, runtimeVersion: options.runtime };
validateTarget(target);
const read = async (key, optional = false) => {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { data: JSON.parse(await r.Body.transformToString()), etag: r.ETag };
  } catch (e) { if (optional && e.$metadata?.httpStatusCode === 404) return null; throw e; }
};
const put = (key, data, immutable = false, etag) => s3.send(new PutObjectCommand({
  Bucket: bucket, Key: key, Body: JSON.stringify(data), ContentType: 'application/json', CacheControl: 'no-store',
  ...(immutable ? { IfNoneMatch: '*' } : etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
}));
const certificate = await readFile(options.certificate ?? new URL('../certs/certificate.pem', import.meta.url), 'utf8');
const requireRuntime = async () => {
  const r = await read(`runtimes/${target.platform}/${target.runtimeVersion}.json`);
  const certHash = createHash('sha256').update(certificate).digest('hex');
  if (r.data.certificateHash !== certHash || r.data.platform !== target.platform || r.data.runtimeVersion !== target.runtimeVersion) throw new Error('Unregistered runtime or certificate mismatch');
};
const privateKey = async () => {
  if (!process.env.OTA_SIGNING_SECRET_ARN) throw new Error('Missing signing secret ARN');
  const result = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.OTA_SIGNING_SECRET_ARN }));
  return result.SecretString;
};
const releaseKey = (id) => {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid release ID');
  return `releases/${id}/${target.platform}.json`;
};
const activate = (id) => activateRelease({ id, target, certificate, assetBaseUrl, read,
  headAsset: (key) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
  writePointer: (key, data, etag) => put(key, data, false, etag),
});

if (command === 'register-build') {
  const build = JSON.parse(await readFile(options.build, 'utf8'));
  if (build.status !== 'FINISHED' || build.project?.id !== '7d29b388-fd9d-4fe2-9f58-649ab0e0f67d' ||
      build.platform?.toLowerCase() !== target.platform || build.runtimeVersion !== target.runtimeVersion || build.fingerprint?.hash !== target.runtimeVersion ||
      !['production', 'production-preview', 'staging'].includes(build.buildProfile) || !/^[a-f0-9]{40}$/.test(build.gitCommitHash ?? '')) {
    throw new Error('Build must be a finished OTA-configured Brokr EAS build with matching runtime');
  }
  const key = `runtimes/${target.platform}/${target.runtimeVersion}.json`;
  const data = { platform: target.platform, runtimeVersion: target.runtimeVersion, buildId: build.id, sourceSha: build.gitCommitHash, certificateHash: createHash('sha256').update(certificate).digest('hex') };
  const existing = await read(key, true);
  if (existing && existing.data.certificateHash !== data.certificateHash) throw new Error('Runtime already registered with another certificate');
  if (!existing) await put(key, data, true);
} else {
  await requireRuntime();
  if (command === 'publish') {
    if (target.channel === 'production') throw new Error('Publish to production-preview, test, then promote');
    const expoConfig = JSON.parse(await readFile(options.config, 'utf8'));
    const environment = target.channel === 'staging' ? 'staging' : 'production';
    if (options.environment !== environment || expoConfig.updates?.requestHeaders?.['expo-channel-name'] !== target.channel) throw new Error('Export environment/channel mismatch');
    const { envelope, uploads, sourceSha } = await prepareRelease({ exportDirectory: options.export, expoConfig, target, privateKey: await privateKey(), certificate, assetBaseUrl, sourceSha: options.sha });
    for (const [key, asset] of uploads) {
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: asset.bytes, ContentType: asset.contentType,
          CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha256: asset.hash }, IfNoneMatch: '*' }));
      } catch (e) { if (e.$metadata?.httpStatusCode !== 412) throw e; }
    }
    const id = JSON.parse(envelope.body).id;
    await put(releaseKey(id), { ...envelope, sourceSha, environment }, true);
    await activate(id);
    console.log(`Published ${target.platform} ${target.channel} release ${id}`);
  } else if (command === 'mark-tested') {
    if (target.channel !== 'production-preview') throw new Error('Mark tested on production-preview only');
    const envelope = (await read(releaseKey(options.release))).data;
    validateEnvelope(envelope, certificate, target);
    const pointer = (await read(`channels/${targetKey(target)}`)).data;
    if (pointer.releaseId !== options.release) throw new Error('Release must be active on preview before marking tested');
    const key = `tested/production-preview/${options.release}/${target.platform}.json`;
    const bodyHash = createHash('sha256').update(envelope.body).digest('hex');
    const previous = await read(key, true);
    if (previous && previous.data.bodyHash !== bodyHash) throw new Error('Existing test attestation differs');
    if (!previous) await put(key, { bodyHash, testedAt: new Date().toISOString() }, true);
  } else if (command === 'promote') {
    const envelope = (await read(releaseKey(options.release))).data;
    if (envelope.environment !== (target.channel === 'staging' ? 'staging' : 'production')) throw new Error('Cannot promote across backend environments');
    await activate(options.release);
  } else if (command === 'rollback') {
    const id = randomUUID();
    const envelope = signedEnvelope('directive', { type: 'rollBackToEmbedded', parameters: { commitTime: new Date().toISOString() } }, await privateKey(), certificate, target, assetBaseUrl);
    await put(releaseKey(id), envelope, true);
    await activate(id);
    console.log(`Activated embedded rollback ${id}`);
  } else { throw new Error('Unknown operation'); }
}
