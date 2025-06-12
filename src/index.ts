import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import 'dotenv/config'
import { analyzeCodeWithGemma, initializeLocalLLM } from "./local-llm-service.js";
import { 
  listGoogleWorkstations,
  startGoogleWorkstation,
  stopGoogleWorkstation,
  getGoogleWorkstation,
  getGoogleWorkstationsConsoleUrl,
  startWorkstationTcpTunnel,
  executeCodeOnWorkstationTunnel,
  fetchWorkstationTunnelResources,
  listGoogleWorkstationClusters,
  listGoogleWorkstationConfigs,
  getWorkstationResources,
  createGoogleWorkstation,
  createGoogleWorkstationCluster,
  createGoogleWorkstationConfig,
  GOOGLE_CLOUD_PROJECT_ID,
} from "./google.js";

let githubPatToken = process.env.GITHUB_PAT_TOKEN || "";
const googleCloudProjectId = GOOGLE_CLOUD_PROJECT_ID;

// Security evaluation mechanism
let currentSecurityToken: string = "";

// Function to generate a random security token
function generateSecurityToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Initialize security token when server starts
currentSecurityToken = generateSecurityToken();
console.error(`🔒 Security token initialized: ${currentSecurityToken}`);

// Create server instance
const server = new McpServer({
  name: "keyboard-mcp",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

interface CreateCodespaceParams {
  token: string;
  owner?: string;
  repo?: string;
  branch?: string;
}

interface ListCodespacesParams {
  token: string;
  repo?: string;
}

interface ExecuteCodeParams {
  codespaceUrl: string;
  code: string;
  token: string;
  environmentVariablesNames: string[];
  docResources: string[];
}

const createInteractiveDocsCodespace = async ({
  token,
  owner = "docsdeveloperdemo",
  repo = "codespace-executor", 
  branch = "main"
}: CreateCodespaceParams): Promise<any | Error> => {
  try {

    const body = {
      "owner": owner,
      "repo": repo,
      "branch": branch,
      
    }

    const { owner: bodyOwner, repo: bodyRepo, branch: bodyBranch = "main" } = body;

    const octokit = new Octokit({
      auth: token,
    });

    // First, get available machine types for the repository
    const machinesResponse = await octokit.rest.codespaces.repoMachinesForAuthenticatedUser({
      owner: bodyOwner,
      repo: bodyRepo,
    });

    // Check if premiumLinux is available, otherwise use standardLinux32gb
    let selectedMachine = "standardLinux32gb"; // default fallback
    const availableMachines = machinesResponse.data.machines;
    
    if (availableMachines.some(machine => machine.name === "premiumLinux")) {
      selectedMachine = "premiumLinux";
    }

    const response = await octokit.rest.codespaces.createWithRepoForAuthenticatedUser({
      owner: bodyOwner,
      repo: bodyRepo,
      ref: bodyBranch,
      location: "WestUs2",
      machine: selectedMachine,
    });

    return {
      success: true,
      codespace: response.data,
      url: response.data.web_url,
      selectedMachine: selectedMachine,
      availableMachines: machinesResponse.data,
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'response' in e) {
      const error = e as { response: { headers: any; status: number }; message: string };
      return {
        success: false,
        error: {
          message: error.message,
          status: error.response.status,
          headers: error.response.headers
        }
      };
    }
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

const listActiveCodespacesForRepo = async ({
  token,
  repo = "codespace-executor",
}: ListCodespacesParams): Promise<any | Error> => {
  try {
    const octokit = new Octokit({
      auth: token,
    });

    const response = await octokit.rest.codespaces.listForAuthenticatedUser();
    
    // Filter codespaces by repo name and only include active ones
    const matchingCodespaces = response.data.codespaces.filter(codespace => 
      codespace.repository?.name === repo && 
      codespace.state === 'Available'
    );

    return {
      success: true,
      codespaces: matchingCodespaces,
      count: matchingCodespaces.length,
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'response' in e) {
      const error = e as { response: { headers: any; status: number }; message: string };
      return {
        success: false,
        error: {
          message: error.message,
          status: error.response.status,
          headers: error.response.headers
        }
      };
    }
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

const generateCodespacePortUrl = (codespace: any, port: number = 3000): string => {
  try {
    // Extract the codespace name from the web_url
    // web_url format: https://username-reponame-randomstring.github.dev
    const webUrl = codespace.web_url;
    if (!webUrl) {
      throw new Error('Codespace web_url not found');
    }

    // Extract the subdomain part (everything before .github.dev)
    const urlParts = webUrl.replace('https://', '').split('.github.dev');
    if (urlParts.length < 2) {
      throw new Error('Invalid codespace URL format');
    }

    const codespaceSubdomain = urlParts[0];
    
    // Generate the port URL: https://codespace-subdomain-port.app.github.dev
    return `https://${codespaceSubdomain}-${port}.app.github.dev`;
  } catch (error) {
    return `Error generating port URL: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
};

const executeCodeOnCodespace = async ({
  codespaceUrl,
  code,
  environmentVariablesNames,
  docResources,
  token,
}: ExecuteCodeParams): Promise<any | Error> => {
  try {
    const executeUrl = `${codespaceUrl}/execute`;
    
    const requestBody = JSON.stringify({
      code: code,
      environmentVariablesNames,
      docResources
    });

    const response = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'x-github-token': token,
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

const fetchKeyNameAndResources = async ({codespaceUrl, githubPatToken}: {codespaceUrl: string, githubPatToken: string}): Promise<any | Error> => {
  try {
    const response = await fetch(`${codespaceUrl}/fetch_key_name_and_resources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': githubPatToken,
        'x-github-token': githubPatToken,
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

const stopCodespace = async ({
  codespaceName,
  token,
}: {
  codespaceName: string;
  token: string;
}): Promise<any | Error> => {
  try {
    const octokit = new Octokit({
      auth: token,
    });

    const response = await octokit.rest.codespaces.stopForAuthenticatedUser({
      codespace_name: codespaceName,
    });

    return {
      success: true,
      codespace: response.data,
      message: `Codespace ${codespaceName} has been stopped`,
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'response' in e) {
      const error = e as { response: { headers: any; status: number }; message: string };
      return {
        success: false,
        error: {
          message: error.message,
          status: error.response.status,
          headers: error.response.headers
        }
      };
    }
    return {
      success: false,
      error: {
        message: e instanceof Error ? e.message : 'Unknown error occurred'
      }
    };
  }
};

server.tool(
  "create-github-codespace",
  "create a github codespace",
  async () => {
      const response = await createInteractiveDocsCodespace({
          token: githubPatToken
      })

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response),
        },
      ],
    };
  },
);

server.tool(
  "create-local-model-evaluator-codespace",
  "Create a GitHub codespace for the keyboard-dev/local-model-evalualtor repository",
  async () => {
      const response = await createInteractiveDocsCodespace({
          token: githubPatToken,
          owner: "docsdeveloperdemo",
          repo: "local-model-evalualtor"
      })

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response),
        },
      ],
    };
  },
);

server.tool(
  "list-active-codespaces",
  "List active GitHub codespaces for the codespace-executor repo",
  async () => {
      const response = await listActiveCodespacesForRepo({
          token: githubPatToken
      });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "get-codespace-port-urls",
  "Get active codespaces for codespace-executor repo with port 3000 URLs",
  async () => {
      const response = await listActiveCodespacesForRepo({
          token: githubPatToken
      });

      if (!response.success) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }

      const codespacesWithUrls = response.codespaces.map((codespace: any) => ({
        name: codespace.name,
        web_url: codespace.web_url,
        port_3000_url: generateCodespacePortUrl(codespace, 3000),
        state: codespace.state,
        created_at: codespace.created_at,
        last_used_at: codespace.last_used_at
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              count: codespacesWithUrls.length,
              codespaces: codespacesWithUrls
            }, null, 2),
          },
        ],
      };
  },
);

server.tool(
  "evaluate",
  "Get the current security evaluation token and instructions for writing safe code. ALWAYS call this before executing any code.",
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            securityToken: currentSecurityToken,
            instructions: {
              "CRITICAL": "You MUST include this security token in ALL code execution requests",
              "codeGuidelines": [
                "1. Always validate user inputs and sanitize data",
                "2. Never execute code that could harm the system or expose sensitive data",
                "3. Use environment variables for sensitive information, never hardcode secrets",
                "4. Limit file system access to necessary directories only",
                "5. Avoid running shell commands unless absolutely necessary",
                "6. Always handle errors gracefully and provide meaningful error messages",
                "7. Use secure coding practices and follow the principle of least privilege"
              ],
              "securityChecks": [
                "Check for malicious patterns (rm -rf, eval, exec, etc.)",
                "Validate all file paths and prevent directory traversal",
                "Ensure no sensitive data is logged or exposed",
                "Verify network requests are to trusted endpoints only"
              ],
              "requiredParameter": "You must include 'security_token' parameter with the current token in all execute-code functions"
            },
            timestamp: new Date().toISOString(),
            message: "Security evaluation complete. Use the provided token for code execution."
          }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "execute-code-on-codespace",
  "Execute code on a specific codespace using its port 3000 URL",
  {
    codespace_url: z.string().describe("The codespace port 3000 URL (e.g., https://username-repo-abc123-3000.app.github.dev)"),
    code: z.string().describe("The JavaScript/Node.js code to execute"),
    security_token: z.string().describe("Security evaluation token from the 'evaluate' tool - REQUIRED for code execution"),
    environmentVariablesNames: z.array(z.string()).describe("The names of known environment variables in the codespace we can use in the code"),
    installPackages: z.array(z.string()).describe("the list of npm packages already installed in the codespace we can use in the code"),
    relevantDocs: z.array(z.string()).describe("The relevant docs to inform the code to execute"),
  },
  async ({ codespace_url, code, security_token, environmentVariablesNames, installPackages, relevantDocs }) => {
      // Validate security token
      if (security_token !== currentSecurityToken) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ SECURITY ERROR: Invalid or expired security token. Please call the 'evaluate' tool first to get the current token.`,
            },
          ],
        };
      }

      // Generate new security token for next execution
      currentSecurityToken = generateSecurityToken();
      console.error(`🔒 New security token generated: ${currentSecurityToken}`);

      const response = await executeCodeOnCodespace({
          codespaceUrl: codespace_url,
          code: code,
          environmentVariablesNames,
          docResources: relevantDocs,
          token: githubPatToken
      });

      // Check if there was an error and use MCP error handling
      if (!response.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error executing code on codespace: ${response.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...response,
              securityNote: "✅ Code executed successfully. Security token has been refreshed. Call 'evaluate' again before next execution."
            }, null, 2),
          },
        ],
      };
  },
);

server.tool(
  "execute-code-on-active-codespace",
  "Find the first active codespace-executor codespace and execute code on it",
  {
    code: z.string().describe("The JavaScript/Node.js code to execute"),
    security_token: z.string().describe("Security evaluation token from the 'evaluate' tool - REQUIRED for code execution"),
    environmentVariablesNames: z.array(z.string()).describe("The names of known environment variables in the codespace we can use in the code"),
    installPackages: z.array(z.string()).describe("the list of npm packages already installed in the codespace we can use in the code"),
    relevantDocs: z.array(z.string()).describe("The relevant docs to inform the code to execute")
  },
  async ({ code, security_token, environmentVariablesNames, installPackages, relevantDocs }) => {
      // Validate security token
      if (security_token !== currentSecurityToken) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ SECURITY ERROR: Invalid or expired security token. Please call the 'evaluate' tool first to get the current token.`,
            },
          ],
        };
      }

      // Generate new security token for next execution
      currentSecurityToken = generateSecurityToken();
      console.error(`🔒 New security token generated: ${currentSecurityToken}`);

      // First, get active codespaces
      const codespacesResponse = await listActiveCodespacesForRepo({
          token: githubPatToken
      });

      if (!codespacesResponse.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch active codespaces: ${codespacesResponse.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }

      if (codespacesResponse.codespaces.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No active codespaces found for codespace-executor repo",
            },
          ],
        };
      }

      // Use the first active codespace
      const firstCodespace = codespacesResponse.codespaces[0];
      const port3000Url = generateCodespacePortUrl(firstCodespace, 3000);

      if (port3000Url.startsWith('Error')) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error generating codespace URL: ${port3000Url}. Try using the fetch-environment-and-resources tool to get the environment variables and resources available to you before you write and execute the code`,
            },
          ],
        };
      }

      // Execute the code
      const executeResponse = await executeCodeOnCodespace({
          codespaceUrl: port3000Url,
          code: code,
          token: githubPatToken,
          environmentVariablesNames,
          docResources: relevantDocs
      });

      // Check if code execution failed
      if (!executeResponse.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error executing code on codespace ${firstCodespace.name}: ${executeResponse.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              codespace_used: {
                name: firstCodespace.name,
                url: port3000Url
              },
              execution_result: executeResponse,
              securityNote: "✅ Code executed successfully. Security token has been refreshed. Call 'evaluate' again before next execution."
            }, null, 2),
          },
        ],
      };
  },
);

server.tool(
  "fetch-environment-and-resources",
  "If you need to use any code that requires a specific npm or sdk or an API key, use this to check what is available to you before you write and execute the code",
  async () => {
      // First, get active codespaces
      const codespacesResponse = await listActiveCodespacesForRepo({
          token: githubPatToken
      });

      if (!codespacesResponse.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch active codespaces: ${codespacesResponse.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }

      if (codespacesResponse.codespaces.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No active codespaces found for codespace-executor repo",
            },
          ],
        };
      }

      // Use the first active codespace
      const firstCodespace = codespacesResponse.codespaces[0];
      const codespacesPortUrl = generateCodespacePortUrl(firstCodespace, 3000);

      if (codespacesPortUrl.startsWith('Error')) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error generating codespace URL: ${codespacesPortUrl}`,
            },
          ],
        };
      }

      // Fetch key names and resources
      const response = await fetchKeyNameAndResources({codespaceUrl: codespacesPortUrl, githubPatToken});

      // Check if fetching resources failed
      if (!response.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error fetching environment and resources: ${response.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              codespace_used: {
                name: firstCodespace.name,
                url: codespacesPortUrl
              },
              fetch_result: response
            }, null, 2),
          },
        ],
      };
  },
);

server.tool(
  "stop-codespace",
  "Stop a specific GitHub codespace by name",
  {
    codespace_name: z.string().describe("The name of the codespace to stop"),
  },
  async ({ codespace_name }) => {
      const response = await stopCodespace({
          codespaceName: codespace_name,
          token: githubPatToken
      });

      // Check if stopping codespace failed
      if (!response.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error stopping codespace ${codespace_name}: ${response.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
  },
);

server.tool(
  "stop-active-codespace",
  "Find and stop the first active codespace-executor codespace",
  async () => {
      // First, get active codespaces
      const codespacesResponse = await listActiveCodespacesForRepo({
          token: githubPatToken
      });

      if (!codespacesResponse.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch active codespaces: ${codespacesResponse.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }

      if (codespacesResponse.codespaces.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No active codespaces found for codespace-executor repo",
            },
          ],
        };
      }

      // Use the first active codespace
      const firstCodespace = codespacesResponse.codespaces[0];

      // Stop the codespace
      const stopResponse = await stopCodespace({
          codespaceName: firstCodespace.name,
          token: githubPatToken
      });

      // Check if stopping codespace failed
      if (!stopResponse.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error stopping codespace ${firstCodespace.name}: ${stopResponse.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              codespace_stopped: {
                name: firstCodespace.name,
                web_url: firstCodespace.web_url
              },
              stop_result: stopResponse
            }, null, 2),
          },
        ],
      };
  },
);

server.tool(
  "analyze-code",
  "Analyze JavaScript/Node.js code for security issues, malicious patterns, and potential vulnerabilities using AI-powered analysis",
  {
    code: z.string().describe("The JavaScript/Node.js code to analyze"),
    context: z.string().optional().describe("Optional context about what the code is supposed to do"),
  },
  async ({ code, context }) => {
      try {
        // Run Gemma analysis on the code
        console.error('🔍 Analyzing code with Gemma...');
      const codespacesResponse = await listActiveCodespacesForRepo({
          token: githubPatToken
      });

      if (!codespacesResponse.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch active codespaces: ${codespacesResponse.error?.message || 'Unknown error'}`,
            },
          ],
        };
      }
      let firstCodespace = null;
      if(codespacesResponse.codespaces.length > 0) {
        firstCodespace = codespacesResponse.codespaces[0];
      }
      const codespacePortUrl = generateCodespacePortUrl(firstCodespace, 11434);
        
        const analysisResult = await analyzeCodeWithGemma(code, codespacePortUrl, githubPatToken);

        // Return the analysis result
        return {
          content: [
            {
              type: "text",
              text: `🔍 CODE ANALYSIS RESULT:\n\n${JSON.stringify(analysisResult, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Analysis failed: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
            },
          ],
        };
      }
  },
);

server.tool(
  "initialize-llm",
  "Initialize the Local LLM service (Ollama with Gemma model) on the active codespace. This should be run before performing code analysis.",
  async () => {
      try {
        console.log('🚀 Initializing Local LLM service...');
        
        // First, get active codespaces to determine the codespace URL
        const codespacesResponse = await listActiveCodespacesForRepo({
            token: githubPatToken
        });

        if (!codespacesResponse.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to fetch active codespaces: ${codespacesResponse.error?.message || 'Unknown error'}`,
              },
            ],
          };
        }

        if (codespacesResponse.codespaces.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "No active codespaces found for codespace-executor repo. Please create a codespace first.",
              },
            ],
          };
        }

        // Use the first active codespace
        const firstCodespace = codespacesResponse.codespaces[0];
        const codespacePortUrl = generateCodespacePortUrl(firstCodespace, 3000);

        if (codespacePortUrl.startsWith('Error')) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error generating codespace URL: ${codespacePortUrl}`,
              },
            ],
          };
        }

        // Initialize the Local LLM service
        const initResult = await initializeLocalLLM(codespacePortUrl, githubPatToken);

        if (!initResult.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `❌ Failed to initialize Local LLM: ${initResult.error || 'Unknown error'}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "✅ Local LLM service initialized successfully",
                codespace_used: {
                  name: firstCodespace.name,
                  url: codespacePortUrl
                },
                initialization_result: initResult
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ LLM initialization failed: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
            },
          ],
        };
      }
  },
);

// Google Cloud Workstation Tools
server.tool(
  "list-google-workstations",
  "List Google Cloud Workstations",
  {
    project_id: z.string().describe("Google Cloud Project ID"),
    location: z.string().describe("Location/region (e.g., us-central1)"),
    cluster_id: z.string().describe("Workstation cluster ID"),
    config_id: z.string().describe("Workstation configuration ID"),
  },
  async ({ project_id, location, cluster_id, config_id }) => {
    const response = await listGoogleWorkstations({
      projectId: project_id,
      location,
      clusterId: cluster_id,
      configId: config_id,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "start-google-workstation",
  "Start a Google Cloud Workstation",
  {
    workstation_name: z.string().describe("Full workstation resource name (e.g., projects/PROJECT/locations/LOCATION/workstationClusters/CLUSTER/workstationConfigs/CONFIG/workstations/WORKSTATION)"),
  },
  async ({ workstation_name }) => {
    const response = await startGoogleWorkstation(workstation_name);

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error starting Google Workstation: ${response.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "stop-google-workstation",
  "Stop a Google Cloud Workstation",
  {
    workstation_name: z.string().describe("Full workstation resource name"),
  },
  async ({ workstation_name }) => {
    const response = await stopGoogleWorkstation(workstation_name);

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error stopping Google Workstation: ${response.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get-google-workstation",
  "Get details of a Google Cloud Workstation",
  {
    workstation_name: z.string().describe("Full workstation resource name"),
  },
  async ({ workstation_name }) => {
    const response = await getGoogleWorkstation(workstation_name);

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting Google Workstation: ${response.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get-google-workstations-console-url",
  "Get the Google Cloud Console URL for managing workstations",
  {
    project_id: z.string().optional().describe("Google Cloud Project ID (optional)"),
  },
  async ({ project_id }) => {
    const consoleUrl = getGoogleWorkstationsConsoleUrl(project_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            consoleUrl,
            message: "Visit this URL to create and manage Google Cloud Workstations"
          }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "start-workstation-tcp-tunnel",
  "Start a TCP tunnel to a Google Cloud Workstation",
  {
    project_id: z.string().describe("Google Cloud Project ID"),
    cluster: z.string().describe("Workstation cluster ID"),
    config: z.string().describe("Workstation configuration ID"),
    region: z.string().describe("Region (e.g., us-central1)"),
    workstation_id: z.string().describe("Workstation ID"),
    remote_port: z.number().optional().describe("Remote port (default: 80)"),
    local_host_port: z.string().optional().describe("Local host port (default: :8080)"),
  },
  async ({ project_id, cluster, config, region, workstation_id, remote_port, local_host_port }) => {
    const response = await startWorkstationTcpTunnel({
      projectId: project_id,
      cluster,
      config,
      region,
      workstationId: workstation_id,
      remotePort: remote_port,
      localHostPort: local_host_port,
    });

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error starting workstation TCP tunnel: ${response.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "execute-code-on-workstation-tunnel",
  "Execute code on a Google Cloud Workstation via localhost:8080 tunnel",
  {
    code: z.string().describe("The JavaScript/Node.js code to execute"),
    security_token: z.string().describe("Security evaluation token from the 'evaluate' tool - REQUIRED for code execution"),
    environment_variables: z.array(z.string()).optional().describe("Environment variable names available in the workstation"),
    doc_resources: z.array(z.string()).optional().describe("Documentation resources to reference"),
    port: z.number().optional().describe("Local port (default: 8080)"),
  },
  async ({ code, security_token, environment_variables, doc_resources, port }) => {
    // Validate security token
    if (security_token !== currentSecurityToken) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ SECURITY ERROR: Invalid or expired security token. Please call the 'evaluate' tool first to get the current token.`,
          },
        ],
      };
    }

    // Generate new security token for next execution
    currentSecurityToken = generateSecurityToken();
    console.error(`🔒 New security token generated: ${currentSecurityToken}`);

    const response = await executeCodeOnWorkstationTunnel({
      code,
      environmentVariablesNames: environment_variables,
      docResources: doc_resources,
      port,
    });

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error executing code on workstation tunnel: ${response.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...response,
            securityNote: "✅ Code executed successfully. Security token has been refreshed. Call 'evaluate' again before next execution."
          }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "fetch-workstation-tunnel-resources",
  "Fetch environment variables and resources available on the workstation tunnel (localhost:8080)",
  {
    port: z.number().optional().describe("Local port (default: 8080)"),
  },
  async ({ port }) => {
    const response = await fetchWorkstationTunnelResources({
      port,
    });

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error fetching workstation tunnel resources: ${response.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "list-google-workstation-clusters",
  "List Google Cloud Workstation clusters in a specific location",
  {
    project_id: z.string().describe("Google Cloud Project ID"),
    location: z.string().describe("Location/region (e.g., us-central1)"),
  },
  async ({ project_id, location }) => {
    const response = await listGoogleWorkstationClusters(project_id, location);

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error listing workstation clusters: ${response.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get-workstation-resources",
  "Get comprehensive workstation resources including project ID, clusters, and configurations",
  {
    location: z.string().optional().describe("Location/region (default: us-central1)"),
  },
  async ({ location }) => {
    const response = await getWorkstationResources(location);

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error getting workstation resources: ${response.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "create-google-workstation",
  "Create a Google Cloud Workstation with specified machine type and optional startup script",
  {
    project_id: z.string().describe("Google Cloud Project ID"),
    location: z.string().describe("Location/region (e.g., us-central1)"),
    cluster_id: z.string().describe("Workstation cluster ID"),
    config_id: z.string().describe("Workstation configuration ID"),
    workstation_id: z.string().describe("Unique workstation ID"),
    machine_type: z.string().optional().describe("Machine type (default: e2-standard-8)"),
    container_image: z.string().optional().describe("Container image (default: code-oss)"),
    startup_script: z.string().optional().describe("Optional startup script to run when workstation starts"),
  },
  async ({ project_id, location, cluster_id, config_id, workstation_id, machine_type, container_image, startup_script }) => {
    const response = await createGoogleWorkstation({
      projectId: project_id,
      location,
      clusterId: cluster_id,
      configId: config_id,
      workstationId: workstation_id,
      machineType: machine_type,
      containerImage: container_image,
      startupScript: startup_script,
    });

    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `