#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LiveApiStack } from '../lib/live-api-stack';

const app = new cdk.App();
new LiveApiStack(app, 'PatelpbLiveApi', {
  env: { account: '811648143409', region: 'us-east-1' },
  description: 'patelpb.com live API: RS alchemy "Refresh live prices" (trigger + worker Lambdas, schedule, budget) + Scratch gateway writer Lambda',
  bucketName: 'patelpb-com-site',
  distributionId: 'EPJNH9PK97GV8',
  budgetEmail: 'patelpb96@gmail.com',
});
cdk.Tags.of(app).add('project', 'patelpb-live-api');
