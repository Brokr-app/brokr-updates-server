import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateBuildRegistration } from '../service/registration.mjs';

const runtimeVersion = 'a'.repeat(40);
const sourceSha = 'b'.repeat(40);
const certificate = 'public certificate bytes';
const target = { channel: 'production-preview', platform: 'android', runtimeVersion };
const build = { status: 'FINISHED', id: 'build', project: { id: '7d29b388-fd9d-4fe2-9f58-649ab0e0f67d' }, platform: 'ANDROID', runtimeVersion,
  fingerprint: { hash: runtimeVersion }, buildProfile: 'production-preview', gitCommitHash: sourceSha };
const attestation = { sourceSha, platform: 'android', runtimeVersion, channel: 'production-preview', manifestUrl: 'https://ota.example.com/manifest', certificateHash: createHash('sha256').update(certificate).digest('hex') };

test('accepts exact source-derived OTA trust configuration', () => {
  assert.equal(validateBuildRegistration({ build, attestation, target, certificate, manifestUrl: attestation.manifestUrl }).sourceSha, sourceSha);
});

test('rejects mismatched endpoint, certificate, source, channel, runtime, and build profile', () => {
  const changes = [
    { attestation: { ...attestation, manifestUrl: 'https://evil.example.com/manifest' } },
    { attestation: { ...attestation, certificateHash: 'wrong' } },
    { attestation: { ...attestation, sourceSha: 'c'.repeat(40) } },
    { attestation: { ...attestation, channel: 'production' } },
    { attestation: { ...attestation, runtimeVersion: 'd'.repeat(40) } },
    { build: { ...build, buildProfile: 'production' } },
  ];
  for (const change of changes) assert.throws(() => validateBuildRegistration({ build, attestation, target, certificate, manifestUrl: attestation.manifestUrl, ...change }), /trust configuration/);
});
