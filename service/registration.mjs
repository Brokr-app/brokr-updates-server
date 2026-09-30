import { createHash } from 'node:crypto';

const profileChannels = { staging: 'staging', 'production-preview': 'production-preview', production: 'production' };

/** Verify a finished EAS build against configuration derived from its exact trusted source commit. */
export function validateBuildRegistration({ build, attestation, target, certificate, manifestUrl }) {
  const certificateHash = createHash('sha256').update(certificate).digest('hex');
  if (build.status !== 'FINISHED' || build.project?.id !== '7d29b388-fd9d-4fe2-9f58-649ab0e0f67d' ||
      build.platform?.toLowerCase() !== target.platform || build.runtimeVersion !== target.runtimeVersion ||
      build.fingerprint?.hash !== target.runtimeVersion || profileChannels[build.buildProfile] !== target.channel ||
      !/^[a-f0-9]{40}$/.test(build.gitCommitHash ?? '') || attestation.sourceSha !== build.gitCommitHash ||
      attestation.platform !== target.platform || attestation.runtimeVersion !== target.runtimeVersion ||
      attestation.channel !== target.channel || attestation.manifestUrl !== manifestUrl ||
      attestation.certificateHash !== certificateHash) {
    throw new Error('Build trust configuration does not match the registered OTA target');
  }
  return { certificateHash, sourceSha: build.gitCommitHash };
}
