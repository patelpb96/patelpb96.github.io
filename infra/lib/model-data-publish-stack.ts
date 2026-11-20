import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface ModelDataPublishStackProps extends cdk.StackProps {
  /** Public site bucket (not managed here). */
  readonly siteBucketName: string;
  /** CloudFront distribution in front of it (not managed here). */
  readonly distributionId: string;
  /** "owner/repo" whose `main` branch may assume the role. */
  readonly githubRepo: string;
  /**
   * ARN of this account's existing GitHub Actions OIDC provider. An account can have only one provider per URL, so
   * pass it when it already exists (`-c githubOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`);
   * omit it and this stack creates the provider.
   */
  readonly oidcProviderArn?: string;
}

/**
 * Lets the scheduled GitHub workflow (.github/workflows/model-data-refresh.yml) publish the model tracker's two data files:
 *   GitHub Actions (main branch only, short-lived OIDC token, no stored AWS keys)
 *     -> role patelpb-model-data-publisher
 *     -> s3:PutObject on projects/models/data/{latest,effort}.json in the site bucket
 *     -> cloudfront:CreateInvalidation on the site distribution
 * Nothing else: not the rest of the bucket, not the scraper's private state, not the Lambda. Separate from the other stacks so
 * deploying or deleting it never touches the live API or the scraper.
 */
export class ModelDataPublishStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ModelDataPublishStackProps) {
    super(scope, id, props);

    const provider = props.oidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubOidc', props.oidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      });

    const keys = ['projects/models/data/latest.json', 'projects/models/data/effort.json'];

    const role = new iam.Role(this, 'Publisher', {
      roleName: 'patelpb-model-data-publisher',
      description: 'GitHub Actions (main) publishes the model tracker data files to the site bucket and invalidates them',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // exactly this repository's main branch; a fork, another branch or a pull request cannot assume the role
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:ref:refs/heads/main`,
        },
      }),
    });

    // GetObject is only for HeadObject: the workflow compares the live file's ETag with the repository's before uploading.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: keys.map((k) => `arn:aws:s3:::${props.siteBucketName}/${k}`),
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/${props.distributionId}`],
    }));

    new cdk.CfnOutput(this, 'PublisherRoleArn', {
      value: role.roleArn,
      description: 'Set as the repository variable MODELS_PUBLISH_ROLE_ARN; the workflow stays switched off until it exists',
    });
  }
}
