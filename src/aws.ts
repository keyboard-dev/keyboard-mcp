import { 
  EC2Client, 
  RunInstancesCommand, 
  DescribeInstancesCommand, 
  TerminateInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
  _InstanceType
} from '@aws-sdk/client-ec2';
import { 
  CodeCommitClient, 
  CreateRepositoryCommand, 
  ListRepositoriesCommand,
  GetRepositoryCommand,
  DeleteRepositoryCommand
} from '@aws-sdk/client-codecommit';
import { 
  IAMClient, 
  CreateRoleCommand, 
  AttachRolePolicyCommand, 
  CreateInstanceProfileCommand,
  AddRoleToInstanceProfileCommand,
  GetRoleCommand
} from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import 'dotenv/config';

// Environment variables for AWS
export const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
export const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || '';
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';

// Interfaces for AWS operations
export interface CreateEC2InstanceParams {
  instanceName: string;
  instanceType?: _InstanceType | string;
  keyName?: string;
  securityGroupId?: string;
  subnetId?: string;
}

export interface CreateCodeCommitRepoParams {
  repositoryName: string;
  repositoryDescription?: string;
}

export interface ExecuteCodeParams {
  instanceId: string;
  code: string;
  accessToken: string;
}

// Helper function to create AWS clients
const createAWSClients = () => {
  const config = {
    region: AWS_REGION,
    ...(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && {
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      }
    })
  };

  return {
    ec2: new EC2Client(config),
    codecommit: new CodeCommitClient(config),
    iam: new IAMClient(config),
    sts: new STSClient(config)
  };
};

// Validate AWS token
export const validateAWSToken = async (accessToken: string): Promise<any> => {
  try {
    const sts = new STSClient({
      region: AWS_REGION,
      credentials: {
        accessKeyId: accessToken.split(':')[0] || '',
        secretAccessKey: accessToken.split(':')[1] || '',
        sessionToken: accessToken.split(':')[2] || undefined,
      }
    });

    const command = new GetCallerIdentityCommand({});
    const response = await sts.send(command);

    return {
      success: true,
      identity: response,
      userId: response.UserId,
      account: response.Account,
      arn: response.Arn,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Invalid AWS token'
      }
    };
  }
};

// Create IAM role for EC2 instances
export const createEC2Role = async (roleName: string = 'RemoteExecutionRole'): Promise<any> => {
  try {
    const { iam } = createAWSClients();

    // Check if role already exists
    try {
      const getRoleCommand = new GetRoleCommand({ RoleName: roleName });
      const existingRole = await iam.send(getRoleCommand);
      return {
        success: true,
        role: existingRole.Role,
        existed: true
      };
    } catch {
      // Role doesn't exist, create it
    }

    // Trust policy for EC2
    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: 'ec2.amazonaws.com'
          },
          Action: 'sts:AssumeRole'
        }
      ]
    };

    const createRoleCommand = new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      Description: 'Role for remote execution EC2 instances'
    });

    const roleResponse = await iam.send(createRoleCommand);

    // Attach policies
    const policies = [
      'arn:aws:iam::aws:policy/AWSCodeCommitReadOnly',
      'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy'
    ];

    for (const policyArn of policies) {
      const attachPolicyCommand = new AttachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: policyArn
      });
      await iam.send(attachPolicyCommand);
    }

    // Create instance profile
    const createProfileCommand = new CreateInstanceProfileCommand({
      InstanceProfileName: roleName
    });
    await iam.send(createProfileCommand);

    // Add role to instance profile
    const addRoleCommand = new AddRoleToInstanceProfileCommand({
      InstanceProfileName: roleName,
      RoleName: roleName
    });
    await iam.send(addRoleCommand);

    return {
      success: true,
      role: roleResponse.Role,
      existed: false
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to create IAM role'
      }
    };
  }
};

// Create security group for secure access
export const createSecurityGroup = async (groupName: string = 'remote-execution-sg'): Promise<any> => {
  try {
    const { ec2 } = createAWSClients();

    // Check if security group already exists
    try {
      const describeCommand = new DescribeSecurityGroupsCommand({
        GroupNames: [groupName]
      });
      const existingSG = await ec2.send(describeCommand);
      if (existingSG.SecurityGroups && existingSG.SecurityGroups.length > 0) {
        return {
          success: true,
          securityGroup: existingSG.SecurityGroups[0],
          existed: true
        };
      }
    } catch {
      // Security group doesn't exist, create it
    }

    const createSGCommand = new CreateSecurityGroupCommand({
      GroupName: groupName,
      Description: 'Security group for remote execution instances'
    });

    const sgResponse = await ec2.send(createSGCommand);

    // Add rules for HTTPS and our custom execution port
    const rules = [
      {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }]
      },
      {
        IpProtocol: 'tcp',
        FromPort: 3000,
        ToPort: 3000,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }] // You might want to restrict this
      }
    ];

    for (const rule of rules) {
      const authorizeCommand = new AuthorizeSecurityGroupIngressCommand({
        GroupId: sgResponse.GroupId,
        IpPermissions: [rule]
      });
      await ec2.send(authorizeCommand);
    }

    return {
      success: true,
      securityGroup: { GroupId: sgResponse.GroupId },
      existed: false
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to create security group'
      }
    };
  }
};

// Create CodeCommit repository
export const createCodeCommitRepository = async ({
  repositoryName,
  repositoryDescription = 'Remote execution repository'
}: CreateCodeCommitRepoParams): Promise<any> => {
  try {
    const { codecommit } = createAWSClients();

    const command = new CreateRepositoryCommand({
      repositoryName,
      repositoryDescription
    });

    const response = await codecommit.send(command);

    return {
      success: true,
      repository: response.repositoryMetadata,
      cloneUrl: response.repositoryMetadata?.cloneUrlHttp,
      repositoryId: response.repositoryMetadata?.repositoryId
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to create CodeCommit repository'
      }
    };
  }
};

// List CodeCommit repositories
export const listCodeCommitRepositories = async (): Promise<any> => {
  try {
    const { codecommit } = createAWSClients();

    const command = new ListRepositoriesCommand({});
    const response = await codecommit.send(command);

    return {
      success: true,
      repositories: response.repositories || [],
      count: response.repositories?.length || 0
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to list repositories'
      }
    };
  }
};

// Generate user data script for EC2 instance - SIMPLIFIED
const generateUserDataScript = () => {
  const script = `#!/bin/bash
# Update system
yum update -y

# Install Node.js 18
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# Install git
yum install -y git

# Install AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
./aws/install
rm -rf aws awscliv2.zip

# Create execution directory
mkdir -p /opt/remote-execution
cd /opt/remote-execution

# Create package.json
cat > package.json << 'EOF'
{
  "name": "remote-execution-server",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "@aws-sdk/client-sts": "^3.0.0",
    "cors": "^2.8.5"
  }
}
EOF

# Install dependencies
npm install

# Create execution server
cat > server.js << 'EOF'
const express = require('express');
const { exec } = require('child_process');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Validate AWS token middleware
async function validateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const [accessKeyId, secretAccessKey, sessionToken] = token.split(':');

    const sts = new STSClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken && { sessionToken })
      }
    });

    const command = new GetCallerIdentityCommand({});
    const response = await sts.send(command);
    
    req.awsIdentity = response;
    next();
  } catch (error) {
    console.error('Token validation failed:', error);
    res.status(401).json({ error: 'Invalid AWS credentials' });
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Execute code endpoint
app.post('/execute', validateToken, (req, res) => {
  const { code, timeout = 30000, workingDirectory } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: 'Code is required' });
  }

  console.log(\`Executing code for user: \${req.awsIdentity.Arn}\`);

  // Determine working directory - default to codespace-executor if available
  let workDir = '/opt/remote-execution';
  if (workingDirectory) {
    workDir = workingDirectory;
  } else if (fs.existsSync('/opt/remote-execution/codespace-executor')) {
    workDir = '/opt/remote-execution/codespace-executor';
  }

  // Create a temporary file for the code
  const tempFile = \`/tmp/execution_\${Date.now()}.js\`;
  fs.writeFileSync(tempFile, code);

  // Execute the code in the specified working directory
  const child = exec(\`cd \${workDir} && timeout \${Math.floor(timeout/1000)} node \${tempFile}\`, {
    timeout: timeout,
    maxBuffer: 1024 * 1024, // 1MB buffer
    env: { ...process.env, NODE_PATH: \`\${workDir}/node_modules\` }
  }, (error, stdout, stderr) => {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile);
    } catch (e) {
      console.error('Failed to clean up temp file:', e);
    }

    if (error) {
      console.error('Execution error:', error);
      return res.json({
        success: false,
        error: error.message,
        stdout: stdout || '',
        stderr: stderr || '',
        workingDirectory: workDir
      });
    }

    res.json({
      success: true,
      stdout: stdout || '',
      stderr: stderr || '',
      executedBy: req.awsIdentity.Arn,
      workingDirectory: workDir
    });
  });
});

// Get available resources endpoint
app.get('/resources', validateToken, (req, res) => {
  try {
    const resources = {
      workingDirectories: [],
      availableFiles: [],
      environmentVariables: Object.keys(process.env),
      nodeModules: []
    };

    // Check for codespace-executor directory
    if (fs.existsSync('/opt/remote-execution/codespace-executor')) {
      resources.workingDirectories.push('/opt/remote-execution/codespace-executor');
      
      // List key files in codespace-executor
      try {
        const files = fs.readdirSync('/opt/remote-execution/codespace-executor');
        resources.availableFiles = files.slice(0, 20); // Limit to first 20 files
      } catch (e) {
        console.error('Error reading codespace-executor files:', e);
      }

      // Check for node_modules
      const nodeModulesPath = '/opt/remote-execution/codespace-executor/node_modules';
      if (fs.existsSync(nodeModulesPath)) {
        try {
          const modules = fs.readdirSync(nodeModulesPath);
          resources.nodeModules = modules.slice(0, 50); // Limit to first 50 modules
        } catch (e) {
          console.error('Error reading node_modules:', e);
        }
      }
    }

    if (fs.existsSync('/opt/remote-execution/repo')) {
      resources.workingDirectories.push('/opt/remote-execution/repo');
    }

    resources.workingDirectories.push('/opt/remote-execution');

    res.json({
      success: true,
      resources: resources,
      queriedBy: req.awsIdentity.Arn
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Git operations endpoint
app.post('/git/:operation', validateToken, (req, res) => {
  const { operation } = req.params;
  const { repository, branch = 'main', token, targetDirectory } = req.body;

  if (!repository && operation !== 'install') {
    return res.status(400).json({ error: 'Repository URL is required for this operation' });
  }

  let command;
  let targetDir = targetDirectory || '/opt/remote-execution/repo';
  
  // Handle GitHub authentication
  let repoUrl = repository;
  if (token && repository && repository.includes('github.com')) {
    // Insert token for GitHub authentication
    repoUrl = repository.replace('https://github.com/', \`https://\${token}@github.com/\`);
  }

  switch (operation) {
    case 'clone':
      command = \`git clone \${repoUrl} \${targetDir}\`;
      break;
    case 'pull':
      command = \`cd \${targetDir} && git pull origin \${branch}\`;
      break;
    case 'status':
      command = \`cd \${targetDir} && git status\`;
      break;
    case 'install':
      command = \`cd \${targetDir} && npm install\`;
      break;
    default:
      return res.status(400).json({ error: 'Invalid git operation' });
  }

  exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      return res.json({
        success: false,
        error: error.message,
        stdout: stdout || '',
        stderr: stderr || ''
      });
    }

    res.json({
      success: true,
      stdout: stdout || '',
      stderr: stderr || '',
      operation: operation,
      targetDirectory: targetDir
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(\`Remote execution server running on port \${PORT}\`);
});
EOF

# Start the server
nohup node server.js > /var/log/execution-server.log 2>&1 &

echo "Basic EC2 remote execution setup complete!"
`;

  return Buffer.from(script).toString('base64');
};

// Create EC2 instance for remote execution - SIMPLIFIED
export const createEC2Instance = async ({
  instanceName,
  instanceType = 't3.micro',
  keyName,
  securityGroupId,
  subnetId
}: CreateEC2InstanceParams): Promise<any> => {
  try {
    const { ec2 } = createAWSClients();

    // Ensure we have IAM role and security group
    const roleResult = await createEC2Role();
    if (!roleResult.success) {
      throw new Error(`Failed to create IAM role: ${roleResult.error?.message}`);
    }

    let sgId = securityGroupId;
    if (!sgId) {
      const sgResult = await createSecurityGroup();
      if (!sgResult.success) {
        throw new Error(`Failed to create security group: ${sgResult.error?.message}`);
      }
      sgId = sgResult.securityGroup.GroupId;
    }

    const userData = generateUserDataScript();

    const runInstancesCommand = new RunInstancesCommand({
      ImageId: 'ami-0c02fb55956c7d316', // Amazon Linux 2 AMI (update as needed)
      InstanceType: instanceType as _InstanceType,
      MinCount: 1,
      MaxCount: 1,
      SecurityGroupIds: [sgId!],
      UserData: userData,
      IamInstanceProfile: {
        Name: 'RemoteExecutionRole'
      },
      ...(keyName && { KeyName: keyName }),
      ...(subnetId && { SubnetId: subnetId }),
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            {
              Key: 'Name',
              Value: instanceName
            },
            {
              Key: 'Purpose',
              Value: 'RemoteExecution'
            }
          ]
        }
      ]
    });

    const response = await ec2.send(runInstancesCommand);
    const instance = response.Instances?.[0];

    if (!instance) {
      throw new Error('Failed to create instance');
    }

    return {
      success: true,
      instance: instance,
      instanceId: instance.InstanceId,
      executionUrl: `http://${instance.PublicDnsName}:3000`, // Will be available once instance is running
      // Add helper function for setting up codespace executor
      setupCodespaceExecutor: async (accessToken: string, githubToken?: string) => {
        return await setupCodespaceExecutorOnInstance(instance.InstanceId!, accessToken, githubToken);
      }
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to create EC2 instance'
      }
    };
  }
};

// Simple function to setup codespace executor on an existing instance
export const setupCodespaceExecutorOnInstance = async (
  instanceId: string, 
  accessToken: string, 
  githubToken?: string
): Promise<any> => {
  try {
    // Clone codespace-executor
    const cloneResult = await performGitOperationOnEC2({
      instanceId,
      operation: 'clone',
      repository: 'https://github.com/docsdeveloperdemo/codespace-executor.git',
      accessToken,
      githubToken,
      targetDirectory: '/opt/remote-execution/codespace-executor'
    });

    if (!cloneResult.success) {
      return {
        success: false,
        error: `Failed to clone codespace-executor: ${cloneResult.error?.message}`
      };
    }

    // Install dependencies
    const installResult = await performGitOperationOnEC2({
      instanceId,
      operation: 'install',
      accessToken,
      targetDirectory: '/opt/remote-execution/codespace-executor'
    });

    if (!installResult.success) {
      return {
        success: false,
        error: `Failed to install dependencies: ${installResult.error?.message}`
      };
    }

    return {
      success: true,
      message: 'Codespace executor setup complete',
      clone: cloneResult.data,
      install: installResult.data
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to setup codespace executor'
      }
    };
  }
};

// Simplified convenience function
export const createEC2InstanceWithCodespaceExecutor = async ({
  instanceName,
  instanceType = 't3.micro',
  githubToken,
  keyName,
  securityGroupId,
  subnetId
}: {
  instanceName: string;
  instanceType?: _InstanceType | string;
  githubToken?: string;
  keyName?: string;
  securityGroupId?: string;
  subnetId?: string;
}): Promise<any> => {
  // Create basic instance first
  const instanceResult = await createEC2Instance({
    instanceName,
    instanceType,
    keyName,
    securityGroupId,
    subnetId
  });

  if (!instanceResult.success) {
    return instanceResult;
  }

  return {
    ...instanceResult,
    // Override the setup function to include easier access
    setupCodespaceExecutor: async (accessToken: string) => {
      return await setupCodespaceExecutorOnInstance(instanceResult.instanceId, accessToken, githubToken);
    }
  };
};

// Get EC2 instance details
export const getEC2Instance = async (instanceId: string): Promise<any> => {
  try {
    const { ec2 } = createAWSClients();

    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });

    const response = await ec2.send(command);
    const instance = response.Reservations?.[0]?.Instances?.[0];

    if (!instance) {
      throw new Error('Instance not found');
    }

    return {
      success: true,
      instance: instance,
      instanceId: instance.InstanceId,
      state: instance.State?.Name,
      publicDns: instance.PublicDnsName,
      executionUrl: instance.State?.Name === 'running' 
        ? `http://${instance.PublicDnsName}:3000`
        : null
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to get instance details'
      }
    };
  }
};

// Start EC2 instance
export const startEC2Instance = async (instanceId: string): Promise<any> => {
  try {
    const { ec2 } = createAWSClients();

    const command = new StartInstancesCommand({
      InstanceIds: [instanceId]
    });

    const response = await ec2.send(command);

    return {
      success: true,
      instances: response.StartingInstances
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to start instance'
      }
    };
  }
};

// Stop EC2 instance
export const stopEC2Instance = async (instanceId: string): Promise<any> => {
  try {
    const { ec2 } = createAWSClients();

    const command = new StopInstancesCommand({
      InstanceIds: [instanceId]
    });

    const response = await ec2.send(command);

    return {
      success: true,
      instances: response.StoppingInstances
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to stop instance'
      }
    };
  }
};

// Terminate EC2 instance
export const terminateEC2Instance = async (instanceId: string): Promise<any> => {
  try {
    const { ec2 } = createAWSClients();

    const command = new TerminateInstancesCommand({
      InstanceIds: [instanceId]
    });

    const response = await ec2.send(command);

    return {
      success: true,
      instances: response.TerminatingInstances
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to terminate instance'
      }
    };
  }
};

// Execute code on EC2 instance
export const executeCodeOnEC2 = async ({
  instanceId,
  code,
  accessToken
}: ExecuteCodeParams): Promise<any> => {
  try {
    // Get instance details to get the execution URL
    const instanceDetails = await getEC2Instance(instanceId);
    if (!instanceDetails.success || !instanceDetails.executionUrl) {
      throw new Error('Instance not running or execution URL not available');
    }

    const executeUrl = `${instanceDetails.executionUrl}/execute`;

    const response = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
    }

    const responseData = await response.json();
    
    return {
      success: true,
      data: responseData,
      status: response.status,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to execute code'
      }
    };
  }
};

// Get repository details
export const getCodeCommitRepository = async (repositoryName: string): Promise<any> => {
  try {
    const { codecommit } = createAWSClients();

    const command = new GetRepositoryCommand({
      repositoryName
    });

    const response = await codecommit.send(command);

    return {
      success: true,
      repository: response.repositoryMetadata,
      cloneUrl: response.repositoryMetadata?.cloneUrlHttp
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Repository not found'
      }
    };
  }
};

// Delete CodeCommit repository
export const deleteCodeCommitRepository = async (repositoryName: string): Promise<any> => {
  try {
    const { codecommit } = createAWSClients();

    const command = new DeleteRepositoryCommand({
      repositoryName
    });

    const response = await codecommit.send(command);

    return {
      success: true,
      repositoryId: response.repositoryId,
      message: `Repository ${repositoryName} has been deleted`
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to delete repository'
      }
    };
  }
};

// Get available resources on EC2 instance
export const getEC2Resources = async (instanceId: string, accessToken: string): Promise<any> => {
  try {
    // Get instance details to get the execution URL
    const instanceDetails = await getEC2Instance(instanceId);
    if (!instanceDetails.success || !instanceDetails.executionUrl) {
      throw new Error('Instance not running or execution URL not available');
    }

    const resourcesUrl = `${instanceDetails.executionUrl}/resources`;

    const response = await fetch(resourcesUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
    }

    const responseData = await response.json();
    
    return {
      success: true,
      data: responseData,
      status: response.status,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to get resources'
      }
    };
  }
};

// Execute code on EC2 instance with enhanced options
export const executeCodeOnEC2Enhanced = async ({
  instanceId,
  code,
  accessToken,
  workingDirectory,
  timeout = 30000
}: {
  instanceId: string;
  code: string;
  accessToken: string;
  workingDirectory?: string;
  timeout?: number;
}): Promise<any> => {
  try {
    // Get instance details to get the execution URL
    const instanceDetails = await getEC2Instance(instanceId);
    if (!instanceDetails.success || !instanceDetails.executionUrl) {
      throw new Error('Instance not running or execution URL not available');
    }

    const executeUrl = `${instanceDetails.executionUrl}/execute`;

    const response = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        code,
        workingDirectory,
        timeout
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
    }

    const responseData = await response.json();
    
    return {
      success: true,
      data: responseData,
      status: response.status,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to execute code'
      }
    };
  }
};

// Git operations on EC2 instance
export const performGitOperationOnEC2 = async ({
  instanceId,
  operation,
  repository,
  accessToken,
  githubToken,
  targetDirectory,
  branch = 'main'
}: {
  instanceId: string;
  operation: 'clone' | 'pull' | 'status' | 'install';
  repository?: string;
  accessToken: string;
  githubToken?: string;
  targetDirectory?: string;
  branch?: string;
}): Promise<any> => {
  try {
    // Get instance details to get the execution URL
    const instanceDetails = await getEC2Instance(instanceId);
    if (!instanceDetails.success || !instanceDetails.executionUrl) {
      throw new Error('Instance not running or execution URL not available');
    }

    const gitUrl = `${instanceDetails.executionUrl}/git/${operation}`;

    const response = await fetch(gitUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repository,
        branch,
        token: githubToken,
        targetDirectory
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
    }

    const responseData = await response.json();
    
    return {
      success: true,
      data: responseData,
      status: response.status,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to perform git operation'
      }
    };
  }
};

// Sync specific repository to EC2 instance
export const syncRepositoryToEC2 = async ({
  instanceId,
  repositoryUrl,
  accessToken,
  githubToken,
  targetDirectory = '/opt/remote-execution/synced-repo',
  installDependencies = true
}: {
  instanceId: string;
  repositoryUrl: string;
  accessToken: string;
  githubToken?: string;
  targetDirectory?: string;
  installDependencies?: boolean;
}): Promise<any> => {
  try {
    // First clone the repository
    const cloneResult = await performGitOperationOnEC2({
      instanceId,
      operation: 'clone',
      repository: repositoryUrl,
      accessToken,
      githubToken,
      targetDirectory
    });

    if (!cloneResult.success) {
      return cloneResult;
    }

    // Then install dependencies if requested
    if (installDependencies) {
      const installResult = await performGitOperationOnEC2({
        instanceId,
        operation: 'install',
        accessToken,
        targetDirectory
      });

      return {
        success: true,
        clone: cloneResult.data,
        install: installResult.success ? installResult.data : { error: installResult.error }
      };
    }

    return {
      success: true,
      clone: cloneResult.data
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Failed to sync repository'
      }
    };
  }
};
