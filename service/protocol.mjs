import { randomUUID, verify, X509Certificate } from 'node:crypto';
import { parseDictionary, serializeDictionary } from 'structured-headers';

const runtimePattern = /^[a-f0-9]{40,64}$/;

/** Validate the routing tuple without permitting S3 path traversal. */
export function validateTarget({ channel, platform, runtimeVersion }) {
  if (!['staging', 'production', 'production-preview'].includes(channel) ||
      !['ios', 'android'].includes(platform) || !runtimePattern.test(runtimeVersion ?? '')) {
    throw new Error('Invalid channel, platform, or fingerprint runtime');
  }
}

/** Construct the exact pointer path for a single compatible native runtime. */
export function targetKey(target) {
  validateTarget(target);
  return `${target.channel}/${target.platform}/${target.runtimeVersion}.json`;
}

/** Verify stored bytes before serving them; never reserialize signed JSON. */
export function validateEnvelope(envelope, certificate, target) {
  if (!envelope || !['manifest', 'directive'].includes(envelope.kind) ||
      typeof envelope.body !== 'string' || typeof envelope.signature !== 'string' || envelope.keyid !== 'main') {
    throw new Error('Invalid signed envelope');
  }
  const cert = new X509Certificate(certificate);
  if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo) ||
      !verify('RSA-SHA256', Buffer.from(envelope.body), cert.publicKey, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('Invalid or expired update signature');
  }
  const data = JSON.parse(envelope.body);
  if (envelope.platform !== target.platform || envelope.runtimeVersion !== target.runtimeVersion) {
    throw new Error('Update target mismatch');
  }
  if (envelope.kind === 'manifest') {
    if (data.runtimeVersion !== target.runtimeVersion || !/^[a-f0-9-]{36}$/.test(data.id) ||
        !Number.isFinite(Date.parse(data.createdAt)) || !Array.isArray(data.assets) || !data.launchAsset) {
      throw new Error('Invalid manifest');
    }
    for (const asset of [data.launchAsset, ...data.assets]) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(asset.hash ?? '') || typeof asset.key !== 'string' ||
          typeof asset.contentType !== 'string' || !asset.url?.startsWith(`${envelope.assetBaseUrl}/assets/`)) {
        throw new Error('Invalid asset');
      }
    }
  } else if (data.type === 'rollBackToEmbedded') {
    if (!Number.isFinite(Date.parse(data.parameters?.commitTime))) throw new Error('Invalid rollback directive');
  } else if (data.type !== 'noUpdateAvailable') {
    throw new Error('Invalid update directive');
  }
  return data;
}

const commonHeaders = {
  'expo-protocol-version': '1', 'expo-sfv-version': '0',
  'cache-control': 'no-store', 'vary': 'expo-platform, expo-runtime-version, expo-channel-name, accept, expo-expect-signature',
};

/** Serve Expo Updates v1 using pre-signed manifests and directives. */
export async function serve(event, { readPointer, readRelease, readNoUpdate, certificate, assetBaseUrl }) {
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const fail = (statusCode, message) => ({ statusCode, headers: { ...commonHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ error: message }) });
  if (event.requestContext?.http?.method !== 'GET') return fail(405, 'Expected GET');
  if (headers['expo-protocol-version'] !== '1') return fail(400, 'Expected Expo Updates protocol 1');
  const target = { platform: headers['expo-platform'], runtimeVersion: headers['expo-runtime-version'], channel: headers['expo-channel-name'] };
  try { validateTarget(target); } catch { return fail(400, 'Invalid update target'); }
  const accept = headers.accept ?? '*/*';
  const accepts = (type) => accept.split(',').some((entry) => {
    const [mime, ...params] = entry.trim().split(';');
    const q = params.find((p) => p.trim().startsWith('q='));
    return (mime === type || mime === '*/*') && (!q || Number(q.trim().slice(2)) > 0);
  });
  let expected;
  try {
    expected = headers['expo-expect-signature'] ? parseDictionary(headers['expo-expect-signature']) : null;
    if (expected && ((expected.get('keyid')?.[0] ?? 'main') !== 'main' ||
        (expected.get('alg')?.[0] ?? 'rsa-v1_5-sha256') !== 'rsa-v1_5-sha256')) {
      return fail(400, 'Unsupported signing key or algorithm');
    }
  } catch { return fail(400, 'Malformed signature request'); }
  try {
    const pointer = await readPointer(target);
    if (!pointer) return renderEnvelope(await readNoUpdate(target), target, accepts, certificate, assetBaseUrl, commonHeaders, fail);
    if (!/^[a-f0-9-]{36}$/.test(pointer.releaseId ?? '')) throw new Error('Invalid pointer');
    const envelope = await readRelease(pointer.releaseId, target);
    const data = validateEnvelope(envelope, certificate, target);
    if ((envelope.kind === 'manifest' && data.id === headers['expo-current-update-id']) ||
        (envelope.kind === 'directive' && headers['expo-current-update-id'] &&
         headers['expo-current-update-id'] === headers['expo-embedded-update-id'])) {
      return renderEnvelope(await readNoUpdate(target), target, accepts, certificate, assetBaseUrl, commonHeaders, fail);
    }
    return renderEnvelope(envelope, target, accepts, certificate, assetBaseUrl, commonHeaders, fail);
  } catch {
    // Public responses and logs must not expose manifests, request headers, or credentials.
    console.error('OTA storage or integrity failure');
    return fail(503, 'Update service temporarily unavailable');
  }
}

function renderEnvelope(envelope, target, accepts, certificate, assetBaseUrl, commonHeaders, fail) {
  if (envelope.kind === 'manifest' && envelope.assetBaseUrl !== assetBaseUrl) throw new Error('Invalid asset origin');
  validateEnvelope(envelope, certificate, target);
  const signature = serializeDictionary(new Map([
      ['sig', [envelope.signature, new Map()]], ['keyid', ['main', new Map()]], ['alg', ['rsa-v1_5-sha256', new Map()]],
  ]));
  if (accepts('multipart/mixed')) {
    const boundary = `brokr-${randomUUID()}`;
    return {
      statusCode: 200,
      headers: { ...commonHeaders, 'content-type': `multipart/mixed; boundary=${boundary}` },
      body: `--${boundary}\r\ncontent-disposition: form-data; name="${envelope.kind}"\r\ncontent-type: application/json\r\nexpo-signature: ${signature}\r\n\r\n${envelope.body}\r\n--${boundary}--\r\n`,
    };
  }
  if (envelope.kind === 'manifest' && (accepts('application/expo+json') || accepts('application/json'))) {
    return { statusCode: 200, headers: { ...commonHeaders, 'content-type': accepts('application/expo+json') ? 'application/expo+json' : 'application/json', 'expo-signature': signature }, body: envelope.body };
  }
  return fail(406, 'Requested response format unavailable');
}
