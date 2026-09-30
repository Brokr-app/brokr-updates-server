# OTA security

Content domain: both posts and listings. Audience: both brokers and non-brokers.

Only the root service in `service/`, built by `scripts/build.mjs`, is deployed. The upstream example client/server and their publicly known demonstration keys are reference fixtures, never production credentials or deployment inputs.

The production certificate is `certs/certificate.pem`. The matching private key lives in AWS Secrets Manager. Serving Lambda can only read release records, channel pointers and service configuration; it cannot publish or retrieve signing keys. CI receives short-lived AWS credentials through GitHub OIDC, scoped to main-only repository environments and individual channel prefixes. All OTA workflows run only from `main` and use a pinned server commit.

Assets are immutable, content-addressed objects. A manifest signs their SHA-256 hashes. Each request selects exactly one channel, platform and native fingerprint. A release cannot activate before all its assets exist, and production additionally requires a manual test attestation for the identical signed manifest tested on production-preview. Pointer writes use conditional S3 writes; a concurrent publication must be retried, never silently overwritten.

CloudFront origin access control authenticates both S3 and Lambda requests. The Function URL requires AWS IAM, so direct anonymous access is denied. CDN access is limited to `/assets/` and `/manifest`; pointers and release records are not public. Manifest responses are never cached. S3 and Secrets Manager data are retained on stack deletion.

Do not log signing keys, tokens, raw headers, sessions, manifests, or unnecessary personal data. Public failure messages are generic. Logs expire after 30 days; operational alarms are visible in CloudWatch. Configure notification actions separately if needed.

Key rotation requires a new certificate and new native binaries/runtimes. Before replacing the signing key, finish migration of supported installed binaries or implement explicitly reviewed multiple-key support. Do not overwrite the key while old runtimes still require it. Expired certificates reject new OTA updates; track expiration and schedule rotation well in advance.

The current CDK release bundles an advisory-affected `brace-expansion` dependency. It is development/deployment tooling only and excluded from the Lambda bundle; `npm audit --omit=dev` is clean. Recheck upstream CDK updates before deployment-tool upgrades. Never run `npm audit fix --force` indiscriminately.
