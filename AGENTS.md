# Brokr OTA server

Follow the workspace guide. Content domain: both posts and listings. Audience: both brokers and non-brokers.

Read README.md, CONTRIBUTING.md and SECURITY.md before changes. Root `service/`, `scripts/`, `infra/`, and `test/` implement signed AWS OTA delivery. The upstream example directories are reference material and must not be deployed or installed by production workflows. Run npm test, npm run build, and npx cdk synth --quiet. Preserve all credentials and unrelated state; never commit private keys, bundles, deployment.json, cdk.out or graphify-out.
