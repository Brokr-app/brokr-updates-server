import { createHash, randomUUID, sign, verify, X509Certificate } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime';
import { validateTarget, validateEnvelope } from './protocol.mjs';

/** Create a signed envelope, keeping the exact bytes used by the verifier. */
export function signedEnvelope(kind, data, privateKey, certificate, target, assetBaseUrl) {
  const body = JSON.stringify(data);
  const signature = sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64');
  const envelope = { kind, body, signature, keyid: 'main', platform: target.platform, runtimeVersion: target.runtimeVersion, assetBaseUrl };
  if (!verify('RSA-SHA256', Buffer.from(body), new X509Certificate(certificate).publicKey, Buffer.from(signature, 'base64'))) {
    throw new Error('Signing key does not match embedded certificate');
  }
  validateEnvelope(envelope, certificate, target);
  return envelope;
}

/** Convert an Expo export to hashed assets and a signed manifest. */
export async function prepareRelease({ exportDirectory, expoConfig, target, privateKey, certificate, assetBaseUrl, sourceSha, id = randomUUID(), createdAt = new Date().toISOString() }) {
  validateTarget(target);
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('Expected source commit SHA');
  if (!/^https:\/\/[^/]+$/.test(assetBaseUrl)) throw new Error('Expected HTTPS asset origin');
  const root = await realpath(exportDirectory);
  const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
  const files = metadata.fileMetadata?.[target.platform];
  if (!files?.bundle || !Array.isArray(files.assets)) throw new Error('Missing platform export metadata');
  const uploads = new Map();
  const asset = async (relative, ext, launch = false) => {
    const absolute = await realpath(path.resolve(root, relative));
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Export path escapes directory');
    const bytes = await readFile(absolute);
    const hash = createHash('sha256').update(bytes).digest('base64url');
    const key = createHash('md5').update(bytes).digest('hex');
    const contentType = launch ? 'application/javascript' : mime.getType(ext) ?? 'application/octet-stream';
    const objectKey = `assets/${hash}`;
    uploads.set(objectKey, { bytes, contentType, hash });
    return { key, hash, contentType, url: `${assetBaseUrl}/${objectKey}`, ...(!launch && ext ? { fileExtension: `.${ext.replace(/^\./, '')}` } : {}) };
  };
  const data = {
    id, createdAt, runtimeVersion: target.runtimeVersion,
    launchAsset: await asset(files.bundle, null, true),
    assets: await Promise.all(files.assets.map((a) => asset(a.path, a.ext))),
    metadata: {}, extra: { expoClient: expoConfig },
  };
  const envelope = signedEnvelope('manifest', data, privateKey, certificate, target, assetBaseUrl);
  return { envelope, uploads, sourceSha };
}
