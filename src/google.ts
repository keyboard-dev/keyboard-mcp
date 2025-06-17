import { WorkstationsClient } from '@google-cloud/workstations';
import { exec } from 'child_process';
import { promisify } from 'util';
import 'dotenv/config'

const execAsync = promisify(exec);

// Environment variables for Google Cloud
export const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID || "";
export const GOOGLE_CLOUD_KEY_FILE = process.env.GOOGLE_CLOUD_KEY_FILE || "";

// Interfaces for Google Workstation operations
export interface ListWorkstationsParams {
  projectId: string;
  location: string;
  clusterId: string;
  configId: string;
}

export interface StartTcpTunnelParams {
  projectId: string;
  cluster: string;
  config: string;
  region: string;
  workstationId: string;
  remotePort?: number;
  localHostPort?: string;
}

export interface CreateWorkstationParams {
  projectId: string;
  location: string;
  clusterId: string;
  configId: string;
  workstationId: string;
  machineType?: string;
  containerImage?: string;
  startupScript?: string;
}

export interface CreateWorkstationClusterParams {
  projectId: string;
  location: string;
  clusterId: string;
  network?: string;
  subNetwork?: string;
}

export interface CreateWorkstationConfigParams {
  projectId: string;
  location: string;
  clusterId: string;
  configId: string;
  machineType?: string;
  containerImage?: string;
  startupScript?: string;
}

// Helper function to create authenticated client
const createWorkstationsClient = () => {
  const clientOptions: any = {};

  if (GOOGLE_CLOUD_KEY_FILE) {
    clientOptions.keyFilename = GOOGLE_CLOUD_KEY_FILE;
  }
  
  if (GOOGLE_CLOUD_PROJECT_ID) {
    clientOptions.projectId = GOOGLE_CLOUD_PROJECT_ID;
  }
  
  return new WorkstationsClient(clientOptions);
};

// Redirect to Google Cloud Workstations Console
export const getGoogleWorkstationsConsoleUrl = (projectId?: string): string => {
  const baseUrl = 'https://console.cloud.google.com/workstations';
  return projectId ? `${baseUrl}?project=${projectId}` : baseUrl;
};

// List workstations function (simplified - for existing workstations only)
export const listGoogleWorkstations = async ({
  projectId,
  location,
  clusterId,
  configId,
}: ListWorkstationsParams): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    const request = {
      parent: `projects/${projectId}/locations/${location}/workstationClusters/${clusterId}/workstationConfigs/${configId}`,
    };

    const [workstations] = await client.listWorkstations(request);

    const workstationsWithUrls = workstations.map((workstation: any) => {
      const workstationId = workstation.name?.split('/').pop() || '';
      return {
        ...workstation,
        workstationId,
        consoleUrl: getGoogleWorkstationsConsoleUrl(projectId),
      };
    });

    return {
      success: true,
      workstations: workstationsWithUrls,
      count: workstations.length,
      message: `Found ${workstations.length} workstations. To create new workstations, visit: ${getGoogleWorkstationsConsoleUrl(projectId)}`,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      },
      consoleUrl: getGoogleWorkstationsConsoleUrl(projectId),
      message: `Unable to list workstations. Please visit the Google Cloud Console to manage workstations: ${getGoogleWorkstationsConsoleUrl(projectId)}`,
    };
  }
};

// Start workstation function
export const startGoogleWorkstation = async (workstationName: string): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    const request = {
      name: workstationName,
    };

    const [operation] = await client.startWorkstation(request);
    const [response] = await operation.promise();

    return {
      success: true,
      workstation: response,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// Stop workstation function
export const stopGoogleWorkstation = async (workstationName: string): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    const request = {
      name: workstationName,
    };

    const [operation] = await client.stopWorkstation(request);
    const [response] = await operation.promise();

    return {
      success: true,
      workstation: response,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// Get workstation details
export const getGoogleWorkstation = async (workstationName: string): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    const request = {
      name: workstationName,
    };

    const [workstation] = await client.getWorkstation(request);

    return {
      success: true,
      workstation: workstation,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// List workstation clusters
export const listGoogleWorkstationClusters = async (projectId: string, location: string): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    const request = {
      parent: `projects/${projectId}/locations/${location}`,
    };

    const [clusters] = await client.listWorkstationClusters(request);

    return {
      success: true,
      clusters: clusters,
      count: clusters.length,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// List workstation configurations
export const listGoogleWorkstationConfigs = async (
  projectId: string,
  location: string,
  clusterId: string
): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    const request = {
      parent: `projects/${projectId}/locations/${location}/workstationClusters/${clusterId}`,
    };

    const [configs] = await client.listWorkstationConfigs(request);

    return {
      success: true,
      configs: configs,
      count: configs.length,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// Get comprehensive workstation resources
export const getWorkstationResources = async (
  location: string = 'us-central1'
): Promise<any | Error> => {
  try {
    const projectId = GOOGLE_CLOUD_PROJECT_ID;
    
    if (!projectId) {
      return {
        success: false,
        error: {
          message: 'GOOGLE_CLOUD_PROJECT_ID environment variable is not set'
        }
      };
    }

    // Get clusters
    const clustersResult = await listGoogleWorkstationClusters(projectId, location);
    
    if (!clustersResult.success) {
      return {
        success: false,
        error: {
          message: `Failed to list clusters: ${clustersResult.error?.message}`
        }
      };
    }

    // Get configs for each cluster
    const clustersWithConfigs = [];
    
    for (const cluster of clustersResult.clusters) {
      const clusterName = cluster.name;
      const clusterId = clusterName.split('/').pop();
      
      const configsResult = await listGoogleWorkstationConfigs(projectId, location, clusterId);
      
      clustersWithConfigs.push({
        ...cluster,
        clusterId,
        configs: configsResult.success ? configsResult.configs : [],
        configCount: configsResult.success ? configsResult.count : 0,
        configError: configsResult.success ? null : configsResult.error?.message,
      });
    }

    return {
      success: true,
      projectId,
      location,
      clusters: clustersWithConfigs,
      clusterCount: clustersResult.count,
      totalConfigs: clustersWithConfigs.reduce((sum, cluster) => sum + cluster.configCount, 0),
      consoleUrl: getGoogleWorkstationsConsoleUrl(projectId),
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// Start TCP tunnel to workstation using gcloud command
export const startWorkstationTcpTunnel = async ({
  projectId,
  cluster,
  config,
  region,
  workstationId,
  remotePort = 80,
  localHostPort = ':8080'
}: StartTcpTunnelParams): Promise<any | Error> => {
  try {
    const command = `gcloud workstations start-tcp-tunnel \\
      --project=${projectId} \\
      --cluster=${cluster} \\
      --config=${config} \\
      --region=${region} \\
      ${workstationId} ${remotePort} \\
      --local-host-port=${localHostPort}`;

    const { stdout, stderr } = await execAsync(command);

    return {
      success: true,
      stdout,
      stderr,
      message: `TCP tunnel started for workstation ${workstationId}`,
      localUrl: `http://localhost${localHostPort.startsWith(':') ? localHostPort : ':' + localHostPort}`,
    };
  } catch (e: any) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred',
        stdout: e.stdout || '',
        stderr: e.stderr || '',
      }
    };
  }
};

// Execute code on workstation via localhost tunnel
export const executeCodeOnWorkstationTunnel = async ({
  code,
  environmentVariablesNames = [],
  docResources = [],
  port = 8080,
}: {
  code: string;
  environmentVariablesNames?: string[];
  docResources?: string[];
  port?: number;
}): Promise<any | Error> => {
  try {
    const executeUrl = `http://localhost:${port}/execute`;
    
    const requestBody = JSON.stringify({
      code: code,
      environmentVariablesNames,
      docResources
    });

    const response = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestBody,
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
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// Fetch environment variables and resources from workstation tunnel
export const fetchWorkstationTunnelResources = async ({
  port = 3000,
}: {
  port?: number;
} = {}): Promise<any | Error> => {
  try {
    const response = await fetch(`http://localhost:${port}/fetch_key_name_and_resources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
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
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// Create workstation cluster function
export const createGoogleWorkstationCluster = async ({
  projectId,
  location,
  clusterId,
  network,
  subNetwork,
}: CreateWorkstationClusterParams): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    const request = {
      parent: `projects/${projectId}/locations/${location}`,
      workstationClusterId: clusterId,
      workstationCluster: {
        displayName: `Cluster ${clusterId}`,
        ...(network && { network }),
        ...(subNetwork && { subnetwork: subNetwork }),
      },
    };

    const [operation] = await client.createWorkstationCluster(request);
    const [response] = await operation.promise();

    return {
      success: true,
      cluster: response,
      name: response.name,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// Create workstation configuration function
export const createGoogleWorkstationConfig = async ({
  projectId,
  location,
  clusterId,
  configId,
  machineType = 'e2-standard-8',
  containerImage = 'us-west1-docker.pkg.dev/cloud-workstations-images/predefined/code-oss:latest',
  startupScript,
}: CreateWorkstationConfigParams): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    const configRequest: any = {
      parent: `projects/${projectId}/locations/${location}/workstationClusters/${clusterId}`,
      workstationConfigId: configId,
      workstationConfig: {
        displayName: `Config ${configId}`,
        host: {
          gceInstance: {
            machineType: machineType,
          },
        },
        container: {
          image: containerImage,
        },
        idleTimeout: {
          seconds: 1800, // 30 minutes
        },
        runningTimeout: {
          seconds: 43200, // 12 hours
        },
      },
    };

    // Add startup script if provided
    if (startupScript) {
      configRequest.workstationConfig.container.env = {
        STARTUP_SCRIPT: startupScript,
      };
    }

    const [operation] = await client.createWorkstationConfig(configRequest);
    const [response] = await operation.promise();

    return {
      success: true,
      config: response,
      name: response.name,
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

// Create workstation function
export const createGoogleWorkstation = async ({
  projectId,
  location,
  clusterId,
  configId,
  workstationId,
  machineType = 'e2-standard-8',
  containerImage = 'us-west1-docker.pkg.dev/cloud-workstations-images/predefined/code-oss:latest',
  startupScript,
}: CreateWorkstationParams): Promise<any | Error> => {
  try {
    const client = createWorkstationsClient();
    
    // First, ensure cluster exists or create it
    const clusterResult = await listGoogleWorkstationClusters(projectId, location);
    let clusterExists = false;
    
    if (clusterResult.success) {
      clusterExists = clusterResult.clusters.some((cluster: any) => 
        cluster.name.includes(`/workstationClusters/${clusterId}`)
      );
    }
    
    if (!clusterExists) {
      const clusterCreateResult = await createGoogleWorkstationCluster({
        projectId,
        location,
        clusterId,
      });
      
      if (!clusterCreateResult.success) {
        return {
          success: false,
          error: {
            message: `Failed to create cluster: ${clusterCreateResult.error?.message}`
          }
        };
      }
    }
    
    // Next, ensure config exists or create it
    const configResult = await listGoogleWorkstationConfigs(projectId, location, clusterId);
    let configExists = false;
    
    if (configResult.success) {
      configExists = configResult.configs.some((config: any) => 
        config.name.includes(`/workstationConfigs/${configId}`)
      );
    }
    
    if (!configExists) {
      const configCreateResult = await createGoogleWorkstationConfig({
        projectId,
        location,
        clusterId,
        configId,
        machineType,
        containerImage,
        startupScript,
      });
      
      if (!configCreateResult.success) {
        return {
          success: false,
          error: {
            message: `Failed to create config: ${configCreateResult.error?.message}`
          }
        };
      }
    }
    
    // Finally, create the workstation
    const request = {
      parent: `projects/${projectId}/locations/${location}/workstationClusters/${clusterId}/workstationConfigs/${configId}`,
      workstationId: workstationId,
      workstation: {
        displayName: `Workstation ${workstationId}`,
      },
    };

    const [operation] = await client.createWorkstation(request);
    const [response] = await operation.promise();

    return {
      success: true,
      workstation: response,
      name: response.name,
      projectId,
      location,
      clusterId,
      configId,
      workstationId,
      machineType,
      consoleUrl: getGoogleWorkstationsConsoleUrl(projectId),
    };
  } catch (e) {
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
}; 