import { createEC2Instance, performGitOperationOnEC2, getEC2Instance } from './aws.js';

// Much simpler approach - basic instance + post-startup setup
export const createSimpleExecutionInstance = async ({
  instanceName,
  instanceType = 't3.micro'
}: {
  instanceName: string;
  instanceType?: string;
}) => {
  // 1. Create basic instance (fast - ~30 seconds)
  const instance = await createEC2Instance({
    instanceName,
    instanceType,
    // No repositories, no complex setup - just basic Node.js server
  });

  if (!instance.success) {
    return instance;
  }

  return {
    success: true,
    instanceId: instance.instanceId,
    setupCodespaceExecutor: async (accessToken: string, githubToken?: string) => {
      // 2. Setup codespace-executor after instance is running (controllable)
      await performGitOperationOnEC2({
        instanceId: instance.instanceId!,
        operation: 'clone',
        repository: 'https://github.com/docsdeveloperdemo/codespace-executor.git',
        accessToken,
        githubToken,
        targetDirectory: '/opt/remote-execution/codespace-executor'
      });

      // 3. Install dependencies
      await performGitOperationOnEC2({
        instanceId: instance.instanceId!,
        operation: 'install',
        accessToken,
        targetDirectory: '/opt/remote-execution/codespace-executor'
      });

      return { success: true, message: 'Codespace executor setup complete' };
    }
  };
};

// Usage:
// const instance = await createSimpleExecutionInstance({ instanceName: 'my-instance' });
// await waitForInstanceRunning(instance.instanceId);
// await instance.setupCodespaceExecutor(awsToken, githubToken); 