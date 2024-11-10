It's an application to deploy instance on AWS provisioning shadowsocks, the ss server uses below obscusion protocols, 

- v2ray (port `80`)
- xray (port `443`)

## Prerequisites
- An AWS account
- Nodejs LTS installed, such as 14.x
- Configure [aws credential][cli-configure-files] for your account. For new AWS user, you can install [awscli][awscli] firstly, then run `aws configure` to set up it. NOTE: make sure granting the credential with adminstrator privillege.
- A [public hosted zone in Route53][create-public-hosted-zone] for your domain
- Install dependencies of app  
```
yarn install --check-files --frozen-lockfile
npx projen
```
- [Bootstrap AWS CDK environment][cdk-bootstrap](only run once for first time deployment in account and region combination)
```bash
npx cdk bootstrap -c hostedZoneName=<r53 hosted zone domain> -c dnsName=<subdomain>
```

## Deploy
```bash
npx cdk deploy -c servicePass=<the password> -c hostedZoneName=<r53 hosted zone domain> -c dnsName=<subdomain>
```

## Client example
You can use [Clash][clash] as client to connect the server. The example configuration snippet of Clash looks like below,

```yml
proxies:
  # shadowsocks
  # 支持加密方式：
  #   aes-128-gcm aes-192-gcm aes-256-gcm
  #   aes-128-cfb aes-192-cfb aes-256-cfb
  #   aes-128-ctr aes-192-ctr aes-256-ctr
  #   rc4-md5 chacha20 chacha20-ietf xchacha20
  #   chacha20-ietf-poly1305 xchacha20-ietf-poly1305

  - name: "v2ray"
    type: ss
    server: <hostname of your server>
    port: 80
    cipher: chacha20-ietf-poly1305
    password: <password of server>
    plugin: v2ray-plugin
    plugin-opts:
      mode: websocket # 暂时不支持 QUIC 协议
      tls: true # wss
      skip-cert-verify: true
      host: <hostname of your server>
      path: "/"
```

## Cost
- default EC2 instance size is `t2.micro`, which is qualified for [AWS Free Tier][free-tier] in first 12 months of new account
- data transfer out to internet from EC2, [100 GB free per month][dto-free-tier]
- $0.5 per month for [one Route53 public hosted zone][route53-hosted-zone-price]

[cli-configure-files]: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
[aws-configure]: https://awscli.amazonaws.com/v2/documentation/api/latest/reference/configure/index.html
[awscli]: https://aws.amazon.com/cli/
[create-public-hosted-zone]: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/CreatingHostedZone.html
[cdk-bootstrap]: https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html
[clash]: https://github.com/Dreamacro/clash
[free-tier]: https://aws.amazon.com/free/?all-free-tier.sort-by=item.additionalFields.SortRank&all-free-tier.sort-order=asc&awsf.Free%20Tier%20Types=*all&awsf.Free%20Tier%20Categories=*all&all-free-tier.q=ec2&all-free-tier.q_operator=AND
[dto-free-tier]: https://aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month/
[route53-hosted-zone-price]: https://aws.amazon.com/route53/pricing/