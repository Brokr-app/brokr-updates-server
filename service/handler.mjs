import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { serve, targetKey } from './protocol.mjs';

const client = new S3Client({});
const certificate = await readFile(new URL('./certificate.pem', import.meta.url), 'utf8');

async function readJson(key, optional = false) {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: process.env.UPDATES_BUCKET, Key: key }));
    return JSON.parse(await result.Body.transformToString());
  } catch (error) {
    if (optional && (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404)) return null;
    throw error;
  }
}

/** Public read-only update endpoint; publishing is performed separately by CI. */
let configuration;
export const handler = async (event) => {
  try {
    // Config is seeded from deployment outputs. This avoids a CloudFront/Lambda dependency cycle.
    configuration ??= await readJson('config/service.json');
    return await serve(event, {
      certificate, assetBaseUrl: configuration.assetBaseUrl,
      readPointer: (target) => readJson(`channels/${targetKey(target)}`, true),
      readRelease: (id, platform) => readJson(`releases/${id}/${platform}.json`),
    });
  } catch {
    console.error('OTA storage or integrity failure');
    return { statusCode: 503, headers: { 'cache-control': 'no-store' }, body: 'Update service temporarily unavailable' };
  }
};
