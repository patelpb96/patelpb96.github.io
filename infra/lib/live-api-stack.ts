import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';

export interface LiveApiStackProps extends cdk.StackProps {
  /** Existing site bucket (not managed here). */
  readonly bucketName: string;
  /** Existing CloudFront distribution (not managed here; see infra/attach-cloudfront.sh). */
  readonly distributionId: string;
  readonly budgetEmail: string;
}

/**
 * RS alchemy "Refresh live prices" (and, further down, the Scratch "gateway" writer API):
 *   POST https://patelpb.com/api/rs/refresh -> CloudFront (/api/*, Lambda OAC) -> trigger
 *   Function URL (AWS_IAM) -> single-flight S3 lock -> async worker -> s3 live/rs-alchemy/*.
 */
export class LiveApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LiveApiStackProps) {
    super(scope, id, props);

    const bucketArn = `arn:aws:s3:::${props.bucketName}`;
    const liveObjects = `${bucketArn}/live/rs-alchemy/*`;
    const distributionArn = `arn:aws:cloudfront::${this.account}:distribution/${props.distributionId}`;
    const code = lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'rs_refresh'), {
      exclude: ['__pycache__', '*.pyc'],
    });
    const commonEnv = { BUCKET: props.bucketName, LIVE_PREFIX: 'live/rs-alchemy/' };

    // ------------------------------------------------------------------ worker
    const workerLogs = new logs.LogGroup(this, 'WorkerLogs', {
      logGroupName: '/aws/lambda/patelpb-rs-refresh-worker',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const worker = new lambda.Function(this, 'Worker', {
      functionName: 'patelpb-rs-refresh-worker',
      description: 'Fetch RS GE quotes and write live/rs-alchemy/{latest,meta}.json',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'worker.handler',
      code,
      memorySize: 256,
      timeout: cdk.Duration.seconds(120),
      environment: { ...commonEnv, BASE_KEY: 'rs-alchemy/data/latest.json', FETCH_CONCURRENCY: '4' },
      logGroup: workerLogs,
    });
    worker.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.minutes(5) });

    // ----------------------------------------------------------------- trigger
    const triggerLogs = new logs.LogGroup(this, 'TriggerLogs', {
      logGroupName: '/aws/lambda/patelpb-rs-refresh-trigger',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const trigger = new lambda.Function(this, 'Trigger', {
      functionName: 'patelpb-rs-refresh-trigger',
      description: 'POST /api/rs/refresh: cooldown + single-flight lock, then start the worker',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'trigger.handler',
      code,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      environment: { ...commonEnv, WORKER_FUNCTION: worker.functionName },
      logGroup: triggerLogs,
    });
    worker.grantInvoke(trigger);

    const triggerUrl = trigger.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    // CloudFront OAC -> Function URL needs BOTH permissions (InvokeFunctionUrl, and
    // InvokeFunction restricted to invocations via the function URL).
    const cfPrincipal = new iam.ServicePrincipal('cloudfront.amazonaws.com');
    trigger.addPermission('CloudFrontInvokeFunctionUrl', {
      principal: cfPrincipal,
      action: 'lambda:InvokeFunctionUrl',
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
      sourceArn: distributionArn,
    });
    trigger.addPermission('CloudFrontInvokeFunction', {
      principal: cfPrincipal,
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
      sourceArn: distributionArn,
    });

    // --------------------------------------------------------------------- IAM
    // Both functions: read/write/delete only live/rs-alchemy/*. ListBucket lets a GET of
    // a missing key (lock, first meta.json) return 404 NoSuchKey instead of 403.
    const liveRw = new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [liveObjects],
    });
    const list = new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [bucketArn] });
    for (const fn of [trigger, worker]) {
      fn.addToRolePolicy(liveRw);
      fn.addToRolePolicy(list);
    }
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`${bucketArn}/rs-alchemy/data/latest.json`],
    }));

    // --------------------------------------------------------------- schedule
    new scheduler.Schedule(this, 'DailyRefresh', {
      scheduleName: 'patelpb-rs-refresh-daily',
      description: 'Daily live price refresh for the RS alchemy tracker',
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '13' }),
      target: new targets.LambdaInvoke(worker, {
        input: scheduler.ScheduleTargetInput.fromObject({ trigger: 'schedule' }),
        retryAttempts: 0,
      }),
    });

    // ---------------------------------------------- CloudFront OAC (for Lambda)
    const oac = new cloudfront.CfnOriginAccessControl(this, 'TriggerOac', {
      originAccessControlConfig: {
        name: 'patelpb-live-api-lambda',
        description: 'patelpb.com /api/* -> rs refresh trigger Function URL',
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    // ----------------------------------------------------------------- gateway
    // Scratch "gateway": writer-only API for the live, end-to-end encrypted page.
    //   POST /api/gateway/{publish,beat,end} -> CloudFront (/api/gateway/*, edge key check
    //   patelpb-gateway-auth, same Lambda OAC) -> Function URL -> s3 live/gateway/*.
    // The writer key's SHA-256 lives in SSM (created by hand; see infra/README.md).
    const gatewayParam = '/patelpb/gateway/writer-key-sha256';
    const gatewayLogs = new logs.LogGroup(this, 'GatewayLogs', {
      logGroupName: '/aws/lambda/patelpb-gateway',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const gateway = new lambda.Function(this, 'Gateway', {
      functionName: 'patelpb-gateway',
      description: 'POST /api/gateway/{publish,beat,end}: write the encrypted live gateway page',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'gateway'), {
        exclude: ['__pycache__', '*.pyc'],
      }),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      environment: { BUCKET: props.bucketName, LIVE_PREFIX: 'live/gateway/', KEY_HASH_PARAM: gatewayParam },
      logGroup: gatewayLogs,
    });
    const gatewayUrl = gateway.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    gateway.addPermission('CloudFrontInvokeFunctionUrl', {
      principal: cfPrincipal,
      action: 'lambda:InvokeFunctionUrl',
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
      sourceArn: distributionArn,
    });
    gateway.addPermission('CloudFrontInvokeFunction', {
      principal: cfPrincipal,
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
      sourceArn: distributionArn,
    });
    gateway.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${bucketArn}/live/gateway/*`],
    }));
    gateway.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${gatewayParam}`],
    }));

    // ---------------------------------------------------------------- newsroom
    // Private, password-gated "newsroom" relay (projects/newsroom/PROTOCOL.md): the home
    // daemon and the phone page both write encrypted envelopes through one endpoint.
    //   POST /api/newsroom/put -> CloudFront (/api/newsroom/*, edge key check
    //   patelpb-newsroom-auth, same Lambda OAC) -> Function URL -> s3 live/newsroom/*.
    // The key's SHA-256 lives in SSM (written by `python -m newsdesk setup`; see infra/README.md).
    const newsroomParam = '/patelpb/newsroom/key-sha256';
    // Optional 24 h "day" key: "<sha256>:<expires epoch s>" (written by `python -m newsdesk temp`).
    const newsroomTempParam = '/patelpb/newsroom/temp-sha256';
    // Optional open mode: "<sha256>:<expires epoch s>:<limit>" (written by `python -m newsdesk open`).
    const newsroomOpenParam = '/patelpb/newsroom/open-sha256';
    const newsroomLogs = new logs.LogGroup(this, 'NewsroomLogs', {
      logGroupName: '/aws/lambda/patelpb-newsroom',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const newsroom = new lambda.Function(this, 'Newsroom', {
      functionName: 'patelpb-newsroom',
      description: 'POST /api/newsroom/put: write encrypted newsroom objects + the inbox index',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'newsroom'), {
        exclude: ['__pycache__', '*.pyc', 'test_*.py'],
      }),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { BUCKET: props.bucketName, LIVE_PREFIX: 'live/newsroom/', KEY_HASH_PARAM: newsroomParam,
        TEMP_HASH_PARAM: newsroomTempParam, OPEN_HASH_PARAM: newsroomOpenParam },
      logGroup: newsroomLogs,
    });
    const newsroomUrl = newsroom.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    newsroom.addPermission('CloudFrontInvokeFunctionUrl', {
      principal: cfPrincipal,
      action: 'lambda:InvokeFunctionUrl',
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
      sourceArn: distributionArn,
    });
    newsroom.addPermission('CloudFrontInvokeFunction', {
      principal: cfPrincipal,
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
      sourceArn: distributionArn,
    });
    // Get + Put for the inbox/index.json read-modify-write; ListBucket makes a missing
    // index a 404 NoSuchKey (treated as empty) instead of a 403.
    newsroom.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [`${bucketArn}/live/newsroom/*`],
    }));
    newsroom.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [bucketArn] }));
    newsroom.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [newsroomParam, newsroomTempParam, newsroomOpenParam].map(
        (p) => `arn:aws:ssm:${this.region}:${this.account}:parameter${p}`),
    }));

    // ------------------------------------------------------------------ search
    // Password-gated Exa search for /search/ (lambdas/search/handler.py):
    //   POST /api/search/{whoami,search,agent,run} -> CloudFront (/api/search/*, edge key check
    //   patelpb-search-auth, same Lambda OAC, 60 s origin timeout) -> Function URL -> api.exa.ai.
    // SSM (written by infra/search_setup.py): the password token's and the device token's SHA-256,
    // the Exa API key (SecureString, aws/ssm key) and the shared daily spend counter.
    const searchParams = {
      key: '/patelpb/search/key-sha256',
      device: '/patelpb/search/device-sha256',
      exa: '/patelpb/search/exa-api-key',
      spend: '/patelpb/search/spend',
    };
    const searchLogs = new logs.LogGroup(this, 'SearchLogs', {
      logGroupName: '/aws/lambda/patelpb-search',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const search = new lambda.Function(this, 'Search', {
      functionName: 'patelpb-search',
      description: 'POST /api/search/*: password-gated proxy to the Exa search and agent APIs',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'search'), {
        exclude: ['__pycache__', '*.pyc', 'test_*.py'],
      }),
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: { KEY_HASH_PARAM: searchParams.key, DEVICE_HASH_PARAM: searchParams.device,
        EXA_KEY_PARAM: searchParams.exa, SPEND_PARAM: searchParams.spend, DAILY_CAP_USD: '3' },
      logGroup: searchLogs,
    });
    const searchUrl = search.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    search.addPermission('CloudFrontInvokeFunctionUrl', {
      principal: cfPrincipal,
      action: 'lambda:InvokeFunctionUrl',
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
      sourceArn: distributionArn,
    });
    search.addPermission('CloudFrontInvokeFunction', {
      principal: cfPrincipal,
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
      sourceArn: distributionArn,
    });
    // GetParameter on all four (the aws/ssm key policy already lets SSM decrypt for this account);
    // PutParameter only on the spend counter.
    search.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: Object.values(searchParams).map((p) => `arn:aws:ssm:${this.region}:${this.account}:parameter${p}`),
    }));
    search.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${searchParams.spend}`],
    }));

    // ------------------------------------------------------------------ budget
    const subscribers = [{ subscriptionType: 'EMAIL', address: props.budgetEmail }];
    new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: 'patelpb-live-api',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 5, unit: 'USD' },
        costFilters: { Service: ['AWS Lambda', 'AmazonCloudWatch', 'Amazon EventBridge'] },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers,
        },
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers,
        },
      ],
    });

    // ----------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'TriggerFunctionUrl', { value: triggerUrl.url });
    new cdk.CfnOutput(this, 'TriggerOriginDomain', {
      value: cdk.Fn.select(2, cdk.Fn.split('/', triggerUrl.url)),
      description: 'Origin domain for the /api/* CloudFront behavior',
    });
    new cdk.CfnOutput(this, 'GatewayOriginDomain', {
      value: cdk.Fn.select(2, cdk.Fn.split('/', gatewayUrl.url)),
      description: 'Origin domain for the /api/gateway/* CloudFront behavior',
    });
    new cdk.CfnOutput(this, 'GatewayFunctionName', { value: gateway.functionName });
    new cdk.CfnOutput(this, 'GatewayKeyHashParam', { value: gatewayParam });
    new cdk.CfnOutput(this, 'NewsroomOriginDomain', {
      value: cdk.Fn.select(2, cdk.Fn.split('/', newsroomUrl.url)),
      description: 'Origin domain for the /api/newsroom/* CloudFront behavior',
    });
    new cdk.CfnOutput(this, 'NewsroomFunctionName', { value: newsroom.functionName });
    new cdk.CfnOutput(this, 'NewsroomKeyHashParam', { value: newsroomParam });
    new cdk.CfnOutput(this, 'SearchOriginDomain', {
      value: cdk.Fn.select(2, cdk.Fn.split('/', searchUrl.url)),
      description: 'Origin domain for the /api/search/* CloudFront behavior',
    });
    new cdk.CfnOutput(this, 'SearchFunctionName', { value: search.functionName });
    new cdk.CfnOutput(this, 'OriginAccessControlId',{ value: oac.attrId });
    new cdk.CfnOutput(this, 'WorkerFunctionName', { value: worker.functionName });
    new cdk.CfnOutput(this, 'TriggerFunctionName', { value: trigger.functionName });
  }
}
