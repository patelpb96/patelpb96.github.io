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
 * RS alchemy "Refresh live prices":
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
    new cdk.CfnOutput(this, 'OriginAccessControlId', { value: oac.attrId });
    new cdk.CfnOutput(this, 'WorkerFunctionName', { value: worker.functionName });
    new cdk.CfnOutput(this, 'TriggerFunctionName', { value: trigger.functionName });
  }
}
