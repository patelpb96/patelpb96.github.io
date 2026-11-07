#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LiveApiStack } from '../lib/live-api-stack';
import { ModelTrackerStack } from '../lib/model-tracker-stack';

const app = new cdk.App();
new LiveApiStack(app, 'PatelpbLiveApi', {
  env: { account: '811648143409', region: 'us-east-1' },
  description: 'patelpb.com live API: RS alchemy "Refresh live prices" (trigger + worker Lambdas, schedule, budget) + Scratch gateway writer Lambda',
  bucketName: 'patelpb-com-site',
  distributionId: 'EPJNH9PK97GV8',
  budgetEmail: 'patelpb96@gmail.com',
});
new ModelTrackerStack(app, 'PatelpbModelTracker', {
  env: { account: '811648143409', region: 'us-east-1' },
  description: 'patelpb.com model tracker: 6-hourly Exa scrape Lambda, schedule and private state bucket',
  siteBucketName: 'patelpb-com-site',
});
cdk.Tags.of(app).add('project', 'patelpb-live-api');
