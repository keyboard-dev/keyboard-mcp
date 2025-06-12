# AWS Remote Execution Security Model

## Overview

This AWS implementation provides secure remote code execution using EC2 instances with CodeCommit integration. The security model ensures that only authenticated AWS users can interact with the execution servers.

## Authentication Flow

### 1. Token Format
AWS credentials are passed as colon-separated tokens:
```
ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]
```

### 2. Server-Side Validation
Each EC2 instance runs an Express server that validates AWS tokens before allowing any operations:

```javascript
// Middleware validates every request
async function validateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.substring(7);
  const [accessKeyId, secretAccessKey, sessionToken] = token.split(':');

  // Use AWS STS to validate credentials
  const sts = new STSClient({ credentials: { accessKeyId, secretAccessKey, sessionToken } });
  const response = await sts.send(new GetCallerIdentityCommand({}));
  
  req.awsIdentity = response; // Store identity for logging
  next();
}
```

### 3. Request Authentication
Every request to the execution server must include:
```bash
Authorization: Bearer ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]
```

## Security Features

### Network Security
- **Security Groups**: Automatically created with minimal required ports (443, 3000)
- **IAM Roles**: EC2 instances use IAM roles for AWS service access
- **Principle of Least Privilege**: Instances only get CodeCommit read access

### Code Execution Security
- **Isolated Execution**: Each code execution runs in a separate temporary file
- **Timeout Protection**: All executions have configurable timeouts (default 30s)
- **Resource Limits**: Buffer limits prevent memory exhaustion
- **Cleanup**: Temporary files are automatically cleaned up after execution

### Audit Trail
- **Request Logging**: All executions are logged with the user's ARN
- **Identity Tracking**: Every operation shows which AWS user performed it
- **CloudWatch Integration**: Standard EC2 and application logging

## API Endpoints

### Health Check
```bash
GET /health
# No authentication required
```

### Code Execution
```bash
POST /execute
Authorization: Bearer ACCESS_KEY_ID:SECRET_ACCESS_KEY
Content-Type: application/json

{
  "code": "console.log('Hello World');",
  "timeout": 30000
}
```

### Git Operations
```bash
POST /git/clone
Authorization: Bearer ACCESS_KEY_ID:SECRET_ACCESS_KEY
Content-Type: application/json

{
  "repository": "https://git-codecommit.region.amazonaws.com/v1/repos/repo-name",
  "branch": "main"
}
```

## Usage Examples

### Basic Code Execution
```typescript
import { executeCodeOnEC2 } from './aws.js';

const result = await executeCodeOnEC2({
  instanceId: 'i-1234567890abcdef0',
  code: 'console.log("Hello from AWS!");',
  accessToken: 'AKIA....:wJalrXUt....:optional-session-token'
});
```

### Creating and Using an Instance
```typescript
// 1. Create instance with repository
const instance = await createEC2Instance({
  instanceName: 'my-execution-instance',
  instanceType: 't3.micro',
  repositoryUrl: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo'
});

// 2. Wait for it to be running
const running = await getEC2Instance(instance.instanceId);

// 3. Execute code
const result = await executeCodeOnEC2({
  instanceId: instance.instanceId,
  code: 'console.log("Executing on EC2!");',
  accessToken: 'your-aws-credentials'
});
```

## Best Practices

### Token Management
1. **Use IAM Users**: Create dedicated IAM users for remote execution
2. **Temporary Credentials**: Use STS temporary credentials when possible
3. **Principle of Least Privilege**: Grant only necessary permissions
4. **Rotate Regularly**: Rotate access keys regularly

### Network Security
1. **Restrict Source IPs**: Modify security groups to limit source IPs
2. **VPC Placement**: Deploy instances in private subnets when possible
3. **Use HTTPS**: Always use HTTPS in production deployments

### Cost Management
1. **Stop When Idle**: Stop instances when not in use
2. **Use Spot Instances**: Consider spot instances for development
3. **Monitor Usage**: Set up billing alerts
4. **Terminate Unused**: Terminate instances that are no longer needed

## Required AWS Permissions

### For the Management Client
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:DescribeInstances",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:TerminateInstances",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:DescribeSecurityGroups",
        "iam:CreateRole",
        "iam:AttachRolePolicy",
        "iam:CreateInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:GetRole",
        "codecommit:CreateRepository",
        "codecommit:ListRepositories",
        "codecommit:GetRepository",
        "codecommit:DeleteRepository"
      ],
      "Resource": "*"
    }
  ]
}
```

### For Remote Execution Users
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

## Troubleshooting

### Common Issues

1. **401 Unauthorized**: Check that your AWS credentials are valid and formatted correctly
2. **Instance Not Responding**: Wait for the instance to fully initialize (can take 3-5 minutes)
3. **Permission Denied**: Ensure your AWS user has the necessary permissions
4. **Network Timeout**: Check security group rules and network connectivity

### Debug Steps

1. **Check Instance Status**:
   ```bash
   aws ec2 describe-instances --instance-ids i-1234567890abcdef0
   ```

2. **Test Health Endpoint**:
   ```bash
   curl http://your-instance-dns:3000/health
   ```

3. **Check Instance Logs**:
   ```bash
   aws logs describe-log-streams --log-group-name /aws/ec2/user-data
   ```

## Security Considerations

⚠️ **IMPORTANT**: This implementation is designed for development and testing. For production use, consider:

1. **HTTPS Only**: Implement TLS/SSL certificates
2. **VPC Isolation**: Deploy in private subnets with NAT Gateway
3. **Additional Authentication**: Consider multi-factor authentication
4. **Rate Limiting**: Implement request rate limiting
5. **Input Validation**: Add more robust input validation and sanitization
6. **Monitoring**: Set up comprehensive monitoring and alerting 