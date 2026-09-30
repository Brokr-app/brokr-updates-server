import { createHash } from 'node:crypto';
import { targetKey, validateEnvelope } from './protocol.mjs';

/** Validate a complete release before conditionally switching its single runtime pointer. */
export async function activateRelease({ id, target, certificate, assetBaseUrl, read, headAsset, writePointer }) {
  const envelope = (await read(`releases/${target.channel}/${id}/${target.platform}.json`)).data;
  if (envelope.assetBaseUrl !== assetBaseUrl) throw new Error('Wrong asset origin');
  const data = validateEnvelope(envelope, certificate, target);
  if (target.channel === 'production' && envelope.kind === 'manifest') {
    if (envelope.environment !== 'production') throw new Error('Wrong backend environment');
    const tested = (await read(`tested/production-preview/${id}/${target.platform}.json`)).data;
    if (tested.bodyHash !== createHash('sha256').update(envelope.body).digest('hex')) throw new Error('Release has not been marked tested');
  }
  if (envelope.kind === 'manifest') {
    for (const asset of [data.launchAsset, ...data.assets]) {
      const stored = await headAsset(new URL(asset.url).pathname.slice(1));
      if (stored.Metadata?.sha256 !== asset.hash) throw new Error('Missing or mismatched release asset');
    }
  }
  const key = `channels/${targetKey(target)}`;
  const previous = await read(key, true);
  if (previous && envelope.kind === 'manifest') {
    const older = (await read(`releases/${target.channel}/${previous.data.releaseId}/${target.platform}.json`)).data;
    const oldData = validateEnvelope(older, certificate, target);
    const oldTime = older.kind === 'manifest' ? oldData.createdAt : oldData.parameters.commitTime;
    if (Date.parse(data.createdAt) <= Date.parse(oldTime)) {
      throw new Error('Release must be newer than active update; use embedded rollback for recovery');
    }
  }
  await writePointer(key, { releaseId: id, activatedAt: new Date().toISOString() }, previous?.etag);
}
