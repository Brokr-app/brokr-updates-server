# Brokr signed OTA delivery

Content domain: **both posts and listings**. Audience: **both brokers and non-brokers**.

This fork preserves Expo’s reference implementation and MIT history. The production service is the **root project**, not the old `expo-updates-server/` demo. Native binaries still use EAS Build and EAS Submit; OTA uses `expo export`, our signing key, and AWS only.

## Architecture

GitHub Actions exports a platform bundle with its build environment, resolves the native fingerprint, signs the manifest, uploads immutable assets and a release record, then conditionally activates a channel pointer. The app requests `/manifest` from CloudFront. CloudFront forwards that path to an IAM-protected Lambda Function URL; assets come from private S3 through origin access control. **No API Gateway, VM, load balancer, NAT gateway, provisioned concurrency, or EAS Update service is used.**

Staging and production use separate channels. Production-preview uses the production backend and has the same native runtime as production: only the channel header is excluded from the fingerprint. Native dependencies, remaining native config and the signing certificate stay fingerprint inputs. All requests route by channel + platform + fingerprint; there is no fallback to another runtime.

## Develop and deploy

Use Node 24 and npm 11.16.0:

```sh
npm ci
npm test
npm run build
npx cdk synth --quiet
npx cdk deploy --outputs-file deployment.json
```

The first deployment requires an authorized AWS administrator and an existing CDK bootstrap and GitHub OIDC provider in account `890760984192`, region `eu-north-1`. Subsequent deployments run through the protected **Deploy AWS OTA service** workflow on `main`, using the `OTA_DEPLOY_ROLE_ARN` environment variable. CloudFront and all data/key resources are dedicated to OTA. S3, logs and Secrets Manager survive stack deletion.

`deployment.json` is local output. Copy its public endpoint, bucket, secret ARN and role ARNs into the mobile app’s `ota.config.json`. Seed `config/service.json` in the bucket with `{ "assetBaseUrl": "https://<distribution>.cloudfront.net" }`. This file is deployment-owned and prevents a circular CloudFront/Lambda dependency. Bootstrap uploads it; CI publishing roles cannot overwrite it.

Generate the root key with the mobile app’s SDK-compatible `expo-updates codesigning:generate`. The same **public certificate** must be committed at `certs/certificate.pem` here and `certs/ota-certificate.pem` in the app. Store the private key as the raw PEM SecretString in `brokr-updates/signing-key`; never use any of the upstream demonstration keys. Keep an encrypted recovery copy through the organization’s existing secrets process. Do not print the PEM or place it in GitHub variables, app environment variables, bundles, or Git.

## Release workflow

1. Build a new `production-preview`, `production`, or `staging` native binary through EAS. The existing app release workflow remains available for store candidates. Download/install preview binaries through EAS; they are internal builds.
2. Run the app’s **Register native build or manage OTA release** workflow with `register-build` and the finished EAS build ID. Registration rejects pre-OTA builds, another project, wrong platform, or a mismatched fingerprint. Use a preview binary for initial testing, then register the corresponding finished production build.
3. Run **Publish signed OTA update**, selecting one platform and `production-preview` or `staging`. It exports from `main`, uses EAS environment variables as build inputs (not EAS Update), verifies registration, uploads assets, and prints the release UUID. A release never activates with missing assets.
4. Install/run the matching preview binary and verify update download on launch, application on a subsequent launch, offline startup, application behavior and backend environment. Force-close/reopen enough times to download and then apply the update. Do not test OTA in Expo Go or a debug client.
5. Run `mark-tested` on `production-preview` for that platform, runtime and release UUID only after the exact artifact is verified. The attestation records a hash of the signed body.
6. Run `promote` on `production` with that same UUID/runtime. Promotion does not re-export or re-sign. Untested manifests and cross-environment promotion are rejected.
7. Repeat for the other platform; releases and runtimes are independent. Existing users need the new store binary before receiving OTA.

The CLI lives in `scripts/ota.mjs`. The app workflow pins this repository using the `OTA_SERVER_REF` GitHub variable, which must be a reviewed 40-character commit SHA. OIDC roles require the matching protected GitHub environments: `ota-staging`, `ota-production-preview`, `ota-production`, `ota-build-registration`, and `ota-infrastructure` (server repo). Each environment permits only `main`. App operations are manually dispatched without a separate reviewer gate, as approved by the lead because the private repository’s current GitHub plan cannot require reviewers. Infrastructure deployment in this public server fork retains lead approval. Normal PRs never receive publishing credentials.

## Recovery, monitoring and costs

Run the explicit `rollback` operation for one channel/platform/runtime to publish a signed `rollBackToEmbedded` directive with a fresh commit time. This restores the binary’s embedded update when devices next check the service. It does not reach permanently offline devices. Repointing to an older manifest is rejected because native clients select updates by creation time; publish a corrected/newer update for subsequent recovery. Releases are immutable and namespaced by channel, so lower-environment roles cannot replace objects referenced by production. S3 versioning retains pointer history. A publication conflict fails rather than overwriting a concurrent operation; retry after inspecting active state.

Build registration accepts only a finished EAS build whose commit, profile/channel, platform, fingerprint runtime, endpoint and embedded signing-certificate hash match an attestation derived from the exact checked-out main commit. Registration also stores an origin-independent signed `noUpdateAvailable` directive for that target. The public manifest Lambda reads the pre-signed directive and never receives signing-key access. A bucket policy enforces `If-None-Match` for assets, releases, test attestations, runtime records and directives. When an asset already exists, publication downloads and hashes its bytes before treating the conflict as safe deduplication.

CloudWatch tracks Lambda errors, throttling, and storage/signature failures. Logs retain 30 days. Alarms currently have no notification destination; inspect them in CloudWatch or configure approved notification actions separately. Review release-specific application errors during preview testing before marking tested. `OTA_TEST_PRIVATE_KEY_PATH=<temporary-admin-key-path> node scripts/smoke.mjs` exercises the live protocol on a random synthetic runtime, removes only its temporary active pointer, and retains immutable test envelopes/assets. Never point smoke tests at a real native runtime.

Costs include Lambda requests/duration, CloudFront traffic/requests and viewer functions, S3 storage/requests, one Secrets Manager key plus API calls, and CloudWatch logs/alarms. GitHub Actions and EAS native builds keep their existing usage charges. CloudFront uses pay-as-you-go. Assets are content-addressed to avoid duplicate storage/downloads; bandwidth is the likely scaling cost. See SECURITY.md for the development-only upstream CDK advisory and certificate rotation process.

---

# Upstream reference documentation

# Custom Expo Updates Server & Client

This repo contains a server and client that implement the [Expo Updates protocol specification](https://docs.expo.dev/technical-specs/expo-updates-0).

> [!IMPORTANT]
> This repo exists to provide a basic demonstration of how the protocol might be translated to code. It is not guaranteed to be complete, stable, or performant enough to use as a full-fledged backend for expo-updates. Expo does not provide hands-on technical support for custom expo-updates server implementations, including what is in this repo. Issues within the expo-updates client library itself (independent of server) may be reported at https://github.com/expo/expo/issues/new/choose. Any pull requests that add new features to this repository will likely be closed; instead, feel free to fork the repository to add new features.

## Why

Expo provides a set of service named EAS (Expo Application Services), one of which is EAS Update which can host and serve updates for an Expo app using the [`expo-updates`](https://github.com/expo/expo/tree/main/packages/expo-updates) library.

In some cases more control of how updates are sent to an app may be needed, and one option is to implement a custom updates server that adheres to the specification in order to serve update manifests and assets. This repo contains an example server implementation of the specification and a client app configured to use the example server.

## Getting started

### Updates overview

To understand this repo, it's important to understand some terminology around updates:

- **Runtime version**: Type: String. Runtime version specifies the version of the underlying native code your app is running. You'll want to update the runtime version of an update when it relies on new or changed native code, like when you update the Expo SDK, or add in any native modules into your apps. Failing to update an update's runtime version will cause your end-user's app to crash if the update relies on native code the end-user is not running.
- **Platform**: Type: "ios" or "android". Specifies which platform to to provide an update.
- **Manifest**: Described in the protocol. The manifest is an object that describes assets and other details that an Expo app needs to know to load an update.

### How the `expo-update-server` works

The flow for creating an update is as follows:

1. Configure and build a "release" version of an app, then run it on a simulator or deploy to an app store.
2. Run the project locally, make changes, then export the app as an update.
3. In the server repo, we'll copy the update made in #2 to the **expo-update-server/updates** directory, under a corresponding runtime version sub-directory.
4. In the "release" app, force close and reopen the app to make a request for an update from the custom update server. The server will return a manifest that matches the requests platform and runtime version.
5. Once the "release" app receives the manifest, it will then make requests for each asset, which will also be served from this server.
6. Once the app has all the required assets it needs from the server, it will load the update.

## The setup

Note: The app is configured to load updates from the server running at http://localhost:3000. If you prefer to load them from a different base URL (for example, in an Android emulator):
1. Update `.env.local` in the server.
2. Update `updates.url` in `app.json` and re-run the build steps below.

### Create a "release" app

The example Expo project configured for the server is located in **/expo-updates-client**.

#### iOS

Run `yarn` and `yarn ios --configuration Release`.

#### Android

Run `yarn` and then run `yarn android --variant release`.

### Make a change

Let's make a change to the project in /expo-updates-client that we'll want to push as an over-the-air update from our custom server to the "release" app. `cd` in to **/expo-updates-client**, then make a change in **App.js**.

Once you've made a change you're happy with, inside of **/expo-updates-server**, run `yarn expo-publish`. Under the hood, this script runs `npx expo export` in the client, copies the exported app to the server, and then copies the Expo config to the server as well.

### Send an update

Now we're ready to run the update server. Run `yarn dev` in the server folder of this repo to start the server.

In the simulator running the "release" version of the app, force close the app and re-open it. It should make a request to /api/manifest, then requests to /api/assets. After the app loads, it should show any changes you made locally.

## About this server

This server was created with NextJS. You can find the API endpoints in **pages/api/manifest.js** and **pages/api/assets.js**.

The code signing keys and certificates were generated using https://github.com/expo/code-signing-certificates.
