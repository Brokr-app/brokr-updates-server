import { App, Stack, Duration, RemovalPolicy, CfnOutput, aws_s3 as s3, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, aws_secretsmanager as secrets, aws_logs as logs, aws_cloudwatch as cloudwatch } from 'aws-cdk-lib';
import path from 'node:path';

const app = new App();
const stack = new Stack(app, 'BrokrUpdates', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-north-1' } });
const bucket = new s3.Bucket(stack, 'Updates', {
  versioned: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
  removalPolicy: RemovalPolicy.RETAIN,
});
const assetOnly = new cloudfront.Function(stack, 'AssetPathsOnly', {
  code: cloudfront.FunctionCode.fromInline('function handler(event) { var r = event.request; if (r.uri.indexOf("/assets/") !== 0) return {statusCode:404,statusDescription:"Not Found"}; return r; }'),
});
const distribution = new cloudfront.Distribution(stack, 'Assets', {
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    compress: true,
    functionAssociations: [{ function: assetOnly, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
  },
  priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
});
// Defense in depth: CDN identity cannot read envelopes, pointers, or runtime records.
bucket.addToResourcePolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['s3:GetObject'],
  principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')], notResources: [bucket.arnForObjects('assets/*')],
  conditions: { StringEquals: { 'AWS:SourceArn': `arn:aws:cloudfront::${stack.account}:distribution/${distribution.distributionId}` } },
}));
// Content-addressed assets are write-once even if a publisher bypasses the CLI.
bucket.addToResourcePolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['s3:PutObject'],
  principals: [new iam.AnyPrincipal()], resources: [bucket.arnForObjects('assets/*')],
  conditions: { Null: { 's3:if-none-match': 'true' } },
}));
const signingKey = new secrets.Secret(stack, 'SigningKey', {
  secretName: 'brokr-updates/signing-key', description: 'Dedicated OTA RSA private key; populated by bootstrap, never used by serving Lambda',
  removalPolicy: RemovalPolicy.RETAIN,
});
const logGroup = new logs.LogGroup(stack, 'ManifestLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
const fn = new lambda.Function(stack, 'Manifest', {
  runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64,
  code: lambda.Code.fromAsset(path.resolve('dist')), handler: 'handler.handler',
  timeout: Duration.seconds(10), memorySize: 256,
  logGroup,
  environment: { UPDATES_BUCKET: bucket.bucketName },
});
bucket.grantRead(fn, 'channels/*');
bucket.grantRead(fn, 'releases/*');
bucket.grantRead(fn, 'directives/*');
bucket.grantRead(fn, 'config/*');
const functionUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
distribution.addBehavior('/manifest', origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl), {
  viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
  cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
  originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
  allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
});
// New Function URLs require both actions; CDK's OAC currently grants only InvokeFunctionUrl.
new lambda.CfnPermission(stack, 'CloudFrontInvokeFunction', {
  action: 'lambda:InvokeFunction', functionName: fn.functionArn, principal: 'cloudfront.amazonaws.com',
  sourceArn: `arn:aws:cloudfront::${stack.account}:distribution/${distribution.distributionId}`, invokedViaFunctionUrl: true,
});
new cloudwatch.Alarm(stack, 'ManifestErrors', { metric: fn.metricErrors(), threshold: 1, evaluationPeriods: 1 });
new cloudwatch.Alarm(stack, 'ManifestThrottles', { metric: fn.metricThrottles(), threshold: 1, evaluationPeriods: 1 });
const integrityMetric = new logs.MetricFilter(stack, 'IntegrityFailures', { logGroup, filterPattern: logs.FilterPattern.literal('"OTA storage or integrity failure"'), metricNamespace: 'Brokr/OTA', metricName: 'IntegrityFailures', metricValue: '1' });
new cloudwatch.Alarm(stack, 'IntegrityFailureAlarm', { metric: integrityMetric.metric(), threshold: 1, evaluationPeriods: 1 });
const oidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(stack, 'GithubOidc', `arn:aws:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`);
const role = (id, repo, environment) => new iam.Role(stack, id, {
  assumedBy: new iam.WebIdentityPrincipal(oidc.openIdConnectProviderArn, {
    StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': `repo:Brokr-app/${repo}:environment:${environment}` },
  }),
  maxSessionDuration: Duration.hours(1),
});
for (const channel of ['staging', 'production-preview', 'production']) {
  const publisher = role(`Publisher-${channel}`, 'Brokr-App', `ota-${channel}`);
  signingKey.grantRead(publisher);
  bucket.grantRead(publisher, 'assets/*');
  bucket.grantRead(publisher, 'runtimes/*');
  bucket.grantRead(publisher, `channels/${channel}/*`);
  bucket.grantRead(publisher, `releases/${channel}/*`);
  bucket.grantRead(publisher, `tested/${channel}/*`);
  const extraReads = channel === 'production' ? [bucket.arnForObjects('releases/production-preview/*'), bucket.arnForObjects('tested/production-preview/*')] : [];
  if (extraReads.length) publisher.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: extraReads }));
  publisher.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [bucket.arnForObjects('assets/*'), bucket.arnForObjects(`releases/${channel}/*`), bucket.arnForObjects(`channels/${channel}/*`), bucket.arnForObjects(`tested/${channel}/*`)] }));
  new CfnOutput(stack, `PublisherRole-${channel}`, { value: publisher.roleArn });
}
const registrar = role('BuildRegistrar', 'Brokr-App', 'ota-build-registration');
bucket.grantRead(registrar, 'runtimes/*');
bucket.grantRead(registrar, 'directives/*');
signingKey.grantRead(registrar);
registrar.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [bucket.arnForObjects('runtimes/*'), bucket.arnForObjects('directives/*')] }));
const deployer = role('Deployer', 'brokr-updates-server', 'ota-infrastructure');
deployer.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [
  `arn:aws:iam::${stack.account}:role/cdk-hnb659fds-deploy-role-${stack.account}-${stack.region}`,
  `arn:aws:iam::${stack.account}:role/cdk-hnb659fds-file-publishing-role-${stack.account}-${stack.region}`,
  `arn:aws:iam::${stack.account}:role/cdk-hnb659fds-lookup-role-${stack.account}-${stack.region}`,
] }));
deployer.addToPolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks', 'ssm:GetParameter'], resources: [
  `arn:aws:cloudformation:${stack.region}:${stack.account}:stack/CDKToolkit/*`,
  `arn:aws:ssm:${stack.region}:${stack.account}:parameter/cdk-bootstrap/hnb659fds/version`,
] }));
new CfnOutput(stack, 'BucketName', { value: bucket.bucketName });
new CfnOutput(stack, 'ManifestUrl', { value: `https://${distribution.distributionDomainName}/manifest` });
new CfnOutput(stack, 'AssetBaseUrl', { value: `https://${distribution.distributionDomainName}` });
new CfnOutput(stack, 'SigningSecretArn', { value: signingKey.secretArn });
new CfnOutput(stack, 'RegistrarRoleArn', { value: registrar.roleArn });
new CfnOutput(stack, 'DeployerRoleArn', { value: deployer.roleArn });
app.synth();
