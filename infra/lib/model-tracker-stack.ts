import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';

export interface ModelTrackerStackProps extends cdk.StackProps {
  /** Public site bucket (not managed here); the Lambda only READS the model list from it. */
  readonly siteBucketName: string;
}

/**
 * Frontier model tracker scraper (projects/model-tracker/PLAN.md):
 *   EventBridge Scheduler (00/06/12/18 UTC, retries 0) -> patelpb-model-scrape Lambda
 *   -> Exa search (key from the existing /patelpb/search/exa-api-key SecureString)
 *   -> s3://<private state bucket>/state/{hits,runs,candidates}.csv, raw/, locks/, spend/
 * Nothing is published: candidates reach the page only through `python -m scraper.review` and a site deploy.
 * Separate from PatelpbLiveApi so deploying or deleting it never touches the live API.
 */
export class ModelTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ModelTrackerStackProps) {
    super(scope, id, props);

    const params = {
      exa: '/patelpb/search/exa-api-key',          // shared with the search proxy; created by infra/search_setup.py
      typesafe: '/patelpb/models/typesafe-api-key', // optional; absent = Jev judges off
    };

    // Private: raw Exa responses contain article text and are never published.
    const state = new s3.Bucket(this, 'State', {
      bucketName: `patelpb-model-tracker-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,                              // a bad run can't silently destroy the ledgers
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const logGroup = new logs.LogGroup(this, 'ScrapeLogs', {
      logGroupName: '/aws/lambda/patelpb-model-scrape',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Scrape', {
      functionName: 'patelpb-model-scrape',
      description: 'Model tracker: one capped Exa run per 6-hour slot; writes private ledgers only',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'scraper.lambda_handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'projects', 'model-tracker'), {
        // Only the scraper package and its approved parameters ship; never local data, the private plan or tests.
        exclude: ['data', 'data/**', 'seed', 'seed/**', 'PLAN.md', 'test_*.py', '**/__pycache__', '**/*.pyc',
                  'schema.sql', 'build_snapshot.py', 'search_params/argon_reviews', 'search_params/argon_reviews/**'],
      }),
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      // No reserved concurrency: this account's limit is 10 and AWS keeps 10 unreserved, so reserving any fails.
      // One run per slot is enforced by the S3 lock (If-None-Match: *) instead.
      environment: {
        STATE_BUCKET: state.bucketName,
        SITE_BUCKET: props.siteBucketName,
        MODELS_KEY: 'projects/models/data/latest.json',
        EXA_KEY_PARAM: params.exa,
        TYPESAFE_KEY_PARAM: params.typesafe,
      },
      logGroup,
    });
    fn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.minutes(10) });

    state.grantReadWrite(fn, 'state/*');
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [state.bucketArn] }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.siteBucketName}/projects/models/data/latest.json`],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: Object.values(params).map((p) => `arn:aws:ssm:${this.region}:${this.account}:parameter${p}`),
    }));

    new scheduler.Schedule(this, 'Every6h', {
      scheduleName: 'patelpb-model-scrape-6h',
      description: 'Model tracker scrape at 00, 06, 12 and 18 UTC (search_params/caps.json slots_utc)',
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '0/6' }),
      target: new targets.LambdaInvoke(fn, {
        input: scheduler.ScheduleTargetInput.fromObject({ trigger: 'schedule' }),
        retryAttempts: 0,
      }),
    });

    new cdk.CfnOutput(this, 'StateBucket', { value: state.bucketName });
    new cdk.CfnOutput(this, 'ScrapeFunctionName', { value: fn.functionName });
  }
}
