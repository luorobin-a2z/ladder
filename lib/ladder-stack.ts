import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'path';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';


export class LadderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
      isDefault: true,
    });

    const hostedZoneName = this.node.tryGetContext('hostedZoneName');
    const dnsName = this.node.tryGetContext('dnsName');

    if (!hostedZoneName || !dnsName) {
      throw new Error('hostedZoneName and dnsName must be provided');
    }

    const hostedZone = route53.HostedZone.fromLookup(this, 'R53HostedZone', {
      domainName: hostedZoneName,
      privateZone: false,
    });
    
    const password = this.node.tryGetContext('servicePassword');
    if (!password) {
      throw new Error('password must be provided');
    }
    const asset = new assets.Asset(this, 'LadderAsset', {
      path: path.join(__dirname, "docker-compose.yml"),
    });

    const params: ec2.S3DownloadOptions = {
      bucket: asset.bucket,
      bucketKey: asset.s3ObjectKey,
    };
    const s3Path = `s3://${params.bucket.bucketName}/${params.bucketKey}`;
    const localPath = ( params.localFile && params.localFile.length !== 0 ) ? params.localFile : `/tmp/${ params.bucketKey }`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      `mkdir -p $(dirname '${localPath}')`,
      `aws s3 cp '${s3Path}' '${localPath}' --region ${cdk.Aws.REGION}`,
      'TOKEN=`curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"`',
      'cat > r53-records.json << EOF',
      '{ "Changes": [ {',
      '  "Action": "UPSERT",',
      '  "ResourceRecordSet": {',
      `  "Name": "${dnsName}",`,
      '  "Type": "CNAME",',
      '  "TTL": 300,',
      '  "ResourceRecords": [ {',
      '  "Value": "`curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-hostname`" }',
      '  ] } ',
      '} ] }',
      'EOF',
      `aws route53 change-resource-record-sets --hosted-zone-id ${hostedZone.hostedZoneId} --change-batch file://r53-records.json`,
      'yum -y update',
      'modprobe tcp_bbr && modprobe sch_fq && sysctl -w net.ipv4.tcp_congestion_control=bbr',
      // 'dnf clean all',
      // 'dnf makecache',
      // 'dnf -y install docker',
      'yum -y install docker',
      'systemctl enable docker',
      'systemctl start docker',
      'curl -L "https://github.com/docker/compose/releases/download/v2.24.7/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose',
      'chmod +x /usr/local/bin/docker-compose',
      'ln -s /usr/local/bin/docker-compose /usr/bin/docker-compose',
      'cat > .env << EOF',
      `PASSWORD=${password}`,
      `HOST=${dnsName}`,
      'EOF',
      'docker network create traefik',
      `docker-compose --env-file ./.env -f ${localPath} up -d`,
    );

    const securityGroup = new ec2.SecurityGroup(this, 'LadderSecurityGroup', {
      vpc,
      description: 'Security group for Ladder instances',
      allowAllOutbound: true,
    });

    // Add inbound rules
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP'
    );
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS'
    );
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH'
    );

    // Create EC2 key pair
    const key = new ec2.KeyPair(this, 'LadderKeyPair', {
      keyPairName: 'ladder-key-pair',
      type: ec2.KeyPairType.RSA,
    });

    const launchTemplate = new ec2.LaunchTemplate(this, 'LadderLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData,
      securityGroup,
      keyPair: key, // Attach the key pair to the launch template
      role: new iam.Role(this, 'LadderLaunchTemplateRole', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        inlinePolicies: {
          'route53': new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['route53:ChangeResourceRecordSets'],
                resources: [hostedZone.hostedZoneArn],
              }),
            ],
          }),
          's3': new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['s3:GetObject'],
                resources: [asset.bucket.arnForObjects(asset.s3ObjectKey)],
              }),
            ],
          }),
        },
      }),
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'LadderAsg', {
      vpc,
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 2,
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        minInstancesInService: 1,
        maxBatchSize: 1,
        pauseTime: cdk.Duration.minutes(3),
      }),
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      instanceMonitoring: autoscaling.Monitoring.BASIC,
    });

    asg.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    asg.connections.allowFromAnyIpv4(ec2.Port.tcp(22), 'SSH access');
    asg.connections.allowFromAnyIpv4(ec2.Port.tcp(80), 'HTTP access');
    asg.connections.allowFromAnyIpv4(ec2.Port.tcp(443), 'HTTPS access');

    asset.grantRead(asg.role);
  }
}
