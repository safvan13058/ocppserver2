import * as actions from '@aws-cdk/aws-iot-actions-alpha';
import * as iot_core from '@aws-cdk/aws-iot-alpha';
import * as cdk from 'aws-cdk-lib';
import { aws_secretsmanager, aws_iot as iot } from 'aws-cdk-lib';
import { UlimitName } from 'aws-cdk-lib/aws-ecs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaes from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import path from 'path';
import fetch from 'sync-fetch';

interface AwsOcppGatewayStackProps extends cdk.StackProps {
  domainName?: string;
  architecture?: string;
}

export class AwsOcppGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: AwsOcppGatewayStackProps) {
    super(scope, id, {
      ...props,
      description: 'SO9522: This stack deploys resources for OCPP Gateway application.',
    });

    const vpcCidr = '10.0.0.0/16';
    const tcpPort = 8080;
    const tlsPort = 443;
    const mqttPort = 8883;
    const ocppSupportedProtocols = ['ocpp1.6', 'ocpp2.0', 'ocpp2.0.1'];

    const architecture = props?.architecture || 'arm64';
    const cpuArchitecture = architecture === 'arm64' ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64;
    const platform = architecture === 'arm64' ? ecr_assets.Platform.LINUX_ARM64 : ecr_assets.Platform.LINUX_AMD64;

    const defaultLambdaProps = {
      runtime: lambda.Runtime.PYTHON_3_9,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_DAY,
      architecture: lambda.Architecture.ARM_64,
    };

    const vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    const iotDescribeEndpointCr = new cr.AwsCustomResource(this, 'IOTDescribeEndpoint', {
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
          actions: ['iot:DescribeEndpoint'],
        }),
      ]),
      logRetention: logs.RetentionDays.ONE_DAY,
      onUpdate: {
        service: 'Iot',
        action: 'describeEndpoint',
        parameters: { endpointType: 'iot:Data-ATS' },
        physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()),
      },
    });

    const iotEndpoint = iotDescribeEndpointCr.getResponseField('endpointAddress');

    const chargePointTable = new dynamodb.Table(this, 'ChargePointTable', {
      partitionKey: { name: 'chargePointId', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    new iot_core.TopicRule(this, 'CreateThingRule', {
      description: 'Insert new IOT Thing reference into DynamoDB',
      sql: iot_core.IotSql.fromStringAsVer20160323(
        "SELECT thingName as chargePointId FROM '$aws/events/thing/+/created'"
      ),
      actions: [new actions.DynamoDBv2PutItemAction(chargePointTable)],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: { containerInsightsEnabled: true },
      executeCommandConfiguration: {
        logging: ecs.ExecuteCommandLogging.DEFAULT,
      },
    });

    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    chargePointTable.grantReadData(gatewayRole);

    const gatewayExecutionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const ocppGatewayLogGroup = new logs.LogGroup(this, 'OcppGatewayLogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.THREE_DAYS,
    });

    const gatewayTaskDefinition = new ecs.FargateTaskDefinition(this, 'GatewayTaskDefinition', {
      memoryLimitMiB: 1024,
      cpu: 512,
      taskRole: gatewayRole,
      executionRole: gatewayExecutionRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: cpuArchitecture,
      },
    });

    const gatewayContainerImage = new ecs.AssetImage(
      path.join(__dirname, '../src/ocpp-gateway-container'),
      { platform }
    );

    const container = gatewayTaskDefinition.addContainer('GatewayContainer', {
      image: gatewayContainerImage,
      logging: new ecs.AwsLogDriver({
        streamPrefix: 'Gateway',
        logGroup: ocppGatewayLogGroup,
      }),
      environment: {
        AWS_REGION: cdk.Stack.of(this).region,
        DYNAMODB_CHARGE_POINT_TABLE: chargePointTable.tableName,
        IOT_ENDPOINT: iotEndpoint,
        IOT_PORT: `${mqttPort}`,
        OCPP_PROTOCOLS: ocppSupportedProtocols.join(','),
        OCPP_GATEWAY_PORT: `${tcpPort}`,
      },
    });

    container.addUlimits({
      name: UlimitName.NOFILE,
      softLimit: 65536,
      hardLimit: 65536,
    });

    container.addPortMappings({
      containerPort: tcpPort,
      hostPort: tcpPort,
      protocol: ecs.Protocol.TCP,
    });

    const gatewayService = new ecs.FargateService(this, 'GatewayService', {
      cluster,
      taskDefinition: gatewayTaskDefinition,
      desiredCount: 1,
      minHealthyPercent: 0,
    });

    const loadBalancer = new elbv2.NetworkLoadBalancer(this, 'OcppGatewayLoadBalancer', {
      vpc,
      loadBalancerName: 'ocpp-gateway',
      internetFacing: true,
    });

    const listener = loadBalancer.addListener('GatewayListener', {
      port: props?.domainName ? tlsPort : 80,
      protocol: props?.domainName ? elbv2.Protocol.TLS : elbv2.Protocol.TCP,
    });

    listener.addTargets('GatewayTarget', {
      port: tcpPort,
      targets: [gatewayService],
      deregistrationDelay: cdk.Duration.seconds(10),
      healthCheck: {
        healthyThresholdCount: 2,
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
      },
    });

    new cdk.CfnOutput(this, 'WebSocketURL', {
      value: props?.domainName
        ? `wss://gateway.${props.domainName}`
        : `ws://${loadBalancer.loadBalancerDnsName}`,
      description: 'The Gateway WebSocket URL',
    });
  }
}
