# Development

Use Node 24 and npm 11.16.0. Run `npm ci`, `npm test`, `npm run build`, and `npx cdk synth --quiet`. The root project is the AWS production implementation. The upstream demonstration directories remain unmodified for comparison.

Content domain: both posts and listings. Audience: both brokers and non-brokers. Record both dimensions in changes, commits, and PRs. Keep signing keys, deployment outputs, generated bundles, and local graphs out of Git. Commit only the public certificate.

Use focused branches and ready-for-review PRs. No automatic merges or production OTA publishing from pull requests. Preserve the Expo MIT license and upstream Git history.
