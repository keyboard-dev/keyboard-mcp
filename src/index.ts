import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import 'dotenv/config'
import { analyzeCodeWithGemma, initializeLocalLLM } from "./local-llm-service.js";
import { WebSocketManager, WebSocketMessage } from './approver.js';
import { 
  saveScriptTemplate, 
  getScriptTemplate, 
  listScriptTemplates, 
  updateScriptTemplate, 
  deleteScriptTemplate, 
  searchScriptTemplates, 
  interpolateScript,
  SaveScriptSchema,
  GetScriptSchema,
  UpdateScriptSchema,
  DeleteScriptSchema,
  ListScriptsSchema,
  SearchScriptsSchema,
  InterpolateScriptSchema
} from './kb_shortcuts.js';

import { createInteractiveDocsCodespace, listActiveCodespacesForRepo, listAllCodespacesForRepo, generateCodespacePortUrl, fetchKeyNameAndResources, deleteCodespace, stopCodespace, executeCodeOnCodespace } from './codespaces.js';

let githubPatToken = process.env.GITHUB_PAT_TOKEN || "";
let encryptMessages = process.env.ENCRYPT_MESSAGES || true


// Create WebSocketManager instance
let wsManager: WebSocketManager | null = null;

// Security evaluation mechanism
let executionCodeCollection: any = {};

// Function to generate a random execution token
function generateExecutionToken(userId: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  // Initialize user's collection if it doesn't exist, but preserve existing data
  if (!executionCodeCollection[userId]) {
    executionCodeCollection[userId] = {};
  }
  
  // Update execution token without resetting planning data
  executionCodeCollection[userId].executionToken = result;
  executionCodeCollection[userId][result] = {};
  
  return result;
}

function generatePlanningToken(userId: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'plan_' + '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  // Initialize user's planning collection if it doesn't exist
  if (!executionCodeCollection[userId]) {
    executionCodeCollection[userId] = {};
  }
  
  // Store planning token for single use only
  executionCodeCollection[userId].planningToken = result;
  executionCodeCollection[userId][result] = {
    status: 'planned',
    createdAt: new Date().toISOString(),
    plan: null,
    code: null,
    used: false // Track if token has been used
  };
  
  return result;
}

// Create server instance
const server = new McpServer({
  name: "keyboard-mcp",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});



// Add WebSocket connection tool
server.tool(
  "connect-websocket",
  "Connect to the Electron app's WebSocket server",
  {
    url: z.string().default("ws://localhost:8080").describe("WebSocket server URL"),
    reconnectInterval: z.number().default(3000).describe("Reconnection interval in milliseconds"),
    maxReconnectAttempts: z.number().default(5).describe("Maximum number of reconnection attempts"),
    autoReconnect: z.boolean().default(true).describe("Whether to automatically reconnect")
  },
  async ({ url, reconnectInterval, maxReconnectAttempts, autoReconnect }) => {
    try {
      if (wsManager) {
        wsManager.disconnect();
      }

      wsManager = new WebSocketManager({
        url,
        reconnectInterval,
        maxReconnectAttempts,
        autoReconnect
      });

      // Wait a bit to check connection status
      await new Promise(resolve => setTimeout(resolve, 1000));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              status: wsManager.getConnectionState(),
              message: "WebSocket manager initialized",
              config: {
                url,
                reconnectInterval,
                maxReconnectAttempts,
                autoReconnect
              }
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error occurred"
            }, null, 2)
          }
        ]
      };
    }
  }
);

// Add message sending tool
server.tool(
  "send-websocket-message",
  "Send a message through the WebSocket connection and wait for response",
  {
    message: z.string().describe("Message content to send"),
    type: z.string().default("message").describe("Message type"),
    channel: z.string().optional().describe("Optional channel name"),
    title: z.string().describe("Optional title"),
    wait_for_response: z.boolean().default(false).describe("Whether to wait for a response"),
    timeout: z.number().optional().describe("Timeout in milliseconds for waiting for response"),
  },
  async ({ message, type, channel, title, wait_for_response, timeout }) => {
    try {
      if (!wsManager) {
        throw new Error("WebSocket not connected. Please use connect-websocket tool first.");
      }

      if (wait_for_response) {
        const messageObject = {
          id: Date.now().toString(),
          title: title || 'Message with Response',
          body: message,
          timestamp: Date.now(),
          priority: 'normal',
          sender: 'MCP Client',
          requiresResponse: true
        };

        const response = await wsManager.sendAndWaitForApproval(messageObject, timeout);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                status: wsManager.getConnectionState(),
                message: "Message sent and response received",
                response,
                details: {
                  messageType: type,
                  channel,
                  timestamp: new Date().toISOString()
                }
              }, null, 2)
            }
          ]
        };
      } else {
        const success = wsManager.send(message, title);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success,
                status: wsManager.getConnectionState(),
                message: success ? "Message sent successfully" : "Message queued",
                details: {
                  messageType: type,
                  channel,
                  timestamp: new Date().toISOString()
                }
              }, null, 2)
            }
          ]
        };
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error occurred"
            }, null, 2)
          }
        ]
      };
    }
  }
);

// Add approval request tool
server.tool(
  "send-approval-request",
  "Send an approval request through the WebSocket connection and wait for user approval",
  {
    title: z.string().describe("Title of the approval request"),
    body: z.string().describe("Detailed description of what needs approval"),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal").describe("Priority level of the approval"),
    sender: z.string().default("MCP Server").describe("Who is requesting the approval"),
    timeout: z.number().default(300000).describe("Timeout in milliseconds for waiting for approval (default: 5 minutes)"),
  },
  async ({ title, body, priority, sender, timeout }) => {
    try {
      if (!wsManager) {
        throw new Error("WebSocket not connected. Please use connect-websocket tool first.");
      }

      const approvalMessage = {
        id: `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title,
        body,
        timestamp: Date.now(),
        priority,
        sender,
        status: 'pending',
        requiresResponse: true
      };

      console.error(`🔔 Sending approval request: ${title}`);


      const response = await wsManager.sendAndWaitForApproval(
        approvalMessage,
        timeout
      );


      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              status: wsManager.getConnectionState(),
              message: "Approval request sent and response received",
              approvalRequest: approvalMessage,
              approvalResponse: response,
              timestamp: new Date().toISOString()
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error occurred",
              message: "Approval request failed or timed out"
            }, null, 2)
          }
        ]
      };
    }
  }
);


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
  "list-all-codespaces",
  "List all GitHub codespaces (active and inactive) for the codespace-executor repo",
  async () => {
    const response = await listAllCodespacesForRepo({
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
  "list-all-codespaces-for-repo",
  "List all GitHub codespaces (active and inactive) for a specific repository",
  {
    repo_name: z.string().optional().describe("Repository name to filter codespaces (defaults to 'codespace-executor')"),
  },
  async ({ repo_name }) => {
    const response = await listAllCodespacesForRepo({
      token: githubPatToken,
      repo: repo_name
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
  "Evaluate code for security and generate execution token. Uses a planning token (single use only). This is step 2 in the plan -> evaluate -> execute workflow.",
  {
    planning_token: z.string().describe("Planning token from the 'plan' tool - REQUIRED to proceed with evaluation"),
    code: z.string().describe("The whole JavaScript/Node.js code to execute in the codespace"),
    explanation_of_code: z.string().describe("A complete breakdown step by step of what the code does and what services or resources it will use"),
    researchWouldBeHelpful: z.boolean().describe("Whether using the web search tool would be helpful to understand the code better"),
    didResearch: z.boolean().describe("Did research before starting to write the code for the task")
  },
  async ({ planning_token, code, explanation_of_code, researchWouldBeHelpful, didResearch }) => {
    let linesOfCode = code.split("\n").length;
    if(linesOfCode > 400) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "❌ CODE ERROR: Code is too long. Please shorten the code to 400 lines or less"
          }
        ]
      };
    }

    // Check WebSocket connection status
    const defaultUserId = "keyboard-mcp-user";
    if (!executionCodeCollection[defaultUserId]) {
      executionCodeCollection[defaultUserId] = {};
    }
    const webSocketStatus = {
      connected: wsManager !== null,
      connectionState: wsManager ? wsManager.getConnectionState() : "disconnected",
      message: wsManager ? "WebSocket manager is available" : "WebSocket not connected. Use 'connect-websocket' tool to establish connection."
    };

    // Throw MCP error if WebSocket is not connected
    if (!wsManager) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "❌ WEBSOCKET ERROR: WebSocket not connected. Please use the 'connect-websocket' tool to establish connection before running security evaluation."
          }
        ]
      };
    }

    // Check GitHub Codespace status
    let codespaceStatus = {
      available: false,
      count: 0,
      message: "Failed to check codespace status",
      activeCodespaces: []
    };

    try {
      const codespacesResponse = await listActiveCodespacesForRepo({
        token: githubPatToken
      });

      if (codespacesResponse.success) {
        codespaceStatus = {
          available: codespacesResponse.codespaces.length > 0,
          count: codespacesResponse.codespaces.length,
          message: codespacesResponse.codespaces.length > 0
            ? `${codespacesResponse.codespaces.length} active codespace(s) available for code execution`
            : "No active codespaces found. Use 'create-github-codespace' tool to create one.  After that make sure to use the fetch-environment-and-resources tool to get the environment variables and resources available to you before you write and execute the code",
          activeCodespaces: codespacesResponse.codespaces.map((cs: any) => ({
            name: cs.name,
            state: cs.state,
            web_url: cs.web_url,
            created_at: cs.created_at,
            last_used_at: cs.last_used_at
          }))
        };
      } else {
        codespaceStatus.message = `Error checking codespaces: ${codespacesResponse.error?.message || 'Unknown error'}`;
      }
    } catch (error) {
      codespaceStatus.message = `Error checking codespaces: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }

    // Throw MCP error if no active codespaces are available
    if (!codespaceStatus.available) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "❌ CODESPACE ERROR: No active GitHub codespaces found. Please use the 'create-github-codespace' tool to create one before running security evaluation."
          }
        ]
      };
    }

    let activeCodespace = codespaceStatus.activeCodespaces[0];
    let codespacesPortUrl = generateCodespacePortUrl(activeCodespace, 3000);

    const response = await fetchKeyNameAndResources({ codespaceUrl: codespacesPortUrl, githubPatToken });

    // Generate execution token
    const currentExecutionToken = generateExecutionToken(defaultUserId);

    // Prepare evaluation data
    const evaluationData = {
      success: true,
      executionToken: currentExecutionToken,
      connectionStatus: {
        webSocket: webSocketStatus,
        githubCodespaces: codespaceStatus
      },
      instructions: {
        "CRITICAL": "You MUST include this execution token in ALL code execution requests",
        "codeGuidelines": [
          "1. Always validate user inputs and sanitize data",
          "2. Never execute code that could harm the system or expose sensitive data",
          "3. Use environment variables for sensitive information, never hardcode secrets",
          "4. Limit file system access to necessary directories only",
          "5. Avoid running shell commands unless absolutely necessary",
          "6. Always handle errors gracefully and provide meaningful error messages",
          "7. Use secure coding practices and follow the principle of least privilege",
          "8. Very important is try to write one-off scripts, do not try to create app or servers unless explicitly asked to do so",
          "9. Make sure you never overwrite any of the existing files, if you do create files make sure to create a new folder preface of 'temp' at the start",
          "10. Make sure there are no syntax errors for example unescaped special characters or string literal issues",
          "11. If you are using a third party API or libary try to validate what you by searching the web",
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
              message: "Execution token evaluation complete. Use the provided token for code execution."
    };

    // Send approval request via WebSocket if connected
    if (wsManager) {
      try {
        const evaluationSummary = `
Execution Token: ${currentExecutionToken}
WebSocket Status: ${webSocketStatus.connectionState}
Codespaces Available: ${codespaceStatus.count}

This evaluation provides the execution token needed for code execution and current system status.

Code to be executed: ${code}

Explaination of code: ${explanation_of_code}


        `.trim();

        const approvalMessage = {
          id: `evaluate-approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          title: "Security Evaluation Request",
          body: `System evaluation requested:\n\n${evaluationSummary}\n\nApprove to provide execution token and system status?`,
          timestamp: Date.now(),
          priority: "normal" as const,
          sender: "MCP Security System",
          status: 'pending' as const,
          code: code,
          explaination: explanation_of_code,
          codeEval: true,
          requiresResponse: true
        };

        console.error(`🔔 Sending evaluation approval request`);

        const approvalResponse = await wsManager.sendAndWaitForApproval(
          approvalMessage,
          300000 // 5 minutes timeout
        );

        if(approvalResponse.status === 'approved') {
          executionCodeCollection[defaultUserId][currentExecutionToken] = {code: code}
          executionCodeCollection[defaultUserId].executionToken = currentExecutionToken
        }
        

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...evaluationData,
                codespaceResources: response,
                approvalRequest: approvalMessage,
                approvalResponse: approvalResponse,
                approvalNote:  `Evaluation status and completed, status: ${approvalResponse.status}`
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        executionCodeCollection = {}
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : "Unknown error occurred",
                message: "Security evaluation approval failed or timed out"
              }, null, 2)
            }
          ]
        };
      }
    } else {
      executionCodeCollection = {}
      // If no WebSocket connection, return evaluation data with warning
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...evaluationData,
              warning: "⚠️ WebSocket not connected - evaluation returned without approval workflow"
            }, null, 2),
          },
        ],
      };
    }
  }
);


server.tool(
  "execute",
  "Find the first active codespace-executor codespace and execute code on it",
  {
    execution_token: z.string().describe("Execution token from the 'evaluate' tool - REQUIRED for code execution")
  },
  async ({ execution_token }) => {
    const defaultUserId = "keyboard-mcp-user";
    
    // Validate execution token
    let currentExecutionToken = executionCodeCollection[defaultUserId]?.executionToken;
    if (execution_token !== currentExecutionToken) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ EXECUTION ERROR: Invalid or expired execution token. Please call the 'evaluate' tool first to get the current token.`,
          },
        ],
      };
    }

    if (!wsManager) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "❌ WEBSOCKET ERROR: WebSocket not connected. Please use the 'connect-websocket' tool to establish connection before running security evaluation."
          }
        ]
      };
    }

    let code = executionCodeCollection[defaultUserId]?.[execution_token]?.code;

    // Generate new execution token for next execution
    currentExecutionToken = generateExecutionToken(defaultUserId);
    console.error(`🔒 New execution token generated: ${currentExecutionToken}`);

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

    // Clean up used execution token
    if (executionCodeCollection[defaultUserId]) {
      delete executionCodeCollection[defaultUserId][execution_token];
    }
    console.warn("makes it before execute code on codespace")
    // Execute the code
    const executeResponse = await executeCodeOnCodespace({
      codespaceUrl: port3000Url,
      code: code,
      token: githubPatToken,
      wsManager: wsManager
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
    const response = await fetchKeyNameAndResources({ codespaceUrl: codespacesPortUrl, githubPatToken });

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
  "delete-codespace",
  "Delete a specific GitHub codespace by name",
  {
    codespace_name: z.string().describe("The name of the codespace to delete"),
  },
  async ({ codespace_name }) => {
    const response = await deleteCodespace({
      codespaceName: codespace_name,
      token: githubPatToken
    });

    // Check if deleting codespace failed
    if (!response.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error deleting codespace ${codespace_name}: ${response.error?.message || 'Unknown error'}`,
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
  "delete-active-codespace",
  "Find and delete the first active codespace-executor codespace",
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

    // Delete the codespace
    const deleteResponse = await deleteCodespace({
      codespaceName: firstCodespace.name,
      token: githubPatToken
    });

    // Check if deleting codespace failed
    if (!deleteResponse.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error deleting codespace ${firstCodespace.name}: ${deleteResponse.error?.message || 'Unknown error'}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            codespace_deleted: {
              name: firstCodespace.name,
              web_url: firstCodespace.web_url
            },
            delete_result: deleteResponse
          }, null, 2),
        },
      ],
    };
  },
);


server.tool(
  "plan",
  "This should be the first tool you call when you are start tackling a new task. It will create a planning token that can be used ONCE in the evaluate step. Each evaluation requires a new planning token.",
  {
    context_or_documentation_helpful: z.boolean().describe("Whether the task is complex/unknown and would benefit from web research for context or documentation"),
    researched_web_context: z.boolean().describe("Whether web research has already been conducted for this task")
  },
  async ({ context_or_documentation_helpful, researched_web_context }) => {
    const defaultUserId = "keyboard-mcp-user";
    
    // Generate planning token
    const planningToken = generatePlanningToken(defaultUserId);

    const instructions = {
      "GENERAL_WORKFLOW": [
        "pre-requisites: have a codespace available to you",
        "1. Use the plan tool to create a planning token",
        "2. Use the evaluate tool to evaluate the code (consumes the planning token)",
        "3. Use the execute tool to execute the code",
        "4. For each new evaluation, create a new planning token"
      ],
      "CRITICAL_TOOL_INSTRUCTIONs":[
        "When using the evaluate tool you must have a planning token",
        "When using the execute tool you must have an execution token",
        "Each planning token can only be used ONCE - create a new one for each evaluation",
        "Determine the resources available to you for example if the users asks you do something in SaaS app but you lack the credentials to do so, mention that to the user"
      ], 
      "codeGuidelines": [
        "1. Always validate user inputs and sanitize data",
        "2. Never execute code that could harm the system or expose sensitive data",
        "3. Use environment variables for sensitive information, never hardcode secrets",
        "4. Limit file system access to necessary directories only",
        "5. Avoid running shell commands unless absolutely necessary",
        "6. Always handle errors gracefully and provide meaningful error messages",
        "7. Use secure coding practices and follow the principle of least privilege",
        "8. Very important is try to write one-off scripts, do not try to create app or servers unless explicitly asked to do so",
        "9. Make sure you never overwrite any of the existing files, if you do create files make sure to create a new folder preface of 'temp' at the start",
        "10. Make sure there are no syntax errors for example unescaped special characters or string literal issues",
        "11. If you are using a third party API or libary try to validate what you by searching the web",
        "12. Do not try to do any git operations",
      ],
      "securityChecks": [
        "Check for malicious patterns (rm -rf, eval, exec, etc.)",
        "Validate all file paths and prevent directory traversal",
        "Ensure no sensitive data is logged or exposed",
        "Verify network requests are to trusted endpoints only"
      ]
    }
    
    let codespaceStatus = {
      available: false,
      count: 0,
      message: "Failed to check codespace status",
      activeCodespaces: []
    }
    
    try {
      const codespacesResponse = await listActiveCodespacesForRepo({
        token: githubPatToken
      });

      if (codespacesResponse.success) {
        codespaceStatus = {
          available: codespacesResponse.codespaces.length > 0,
          count: codespacesResponse.codespaces.length,
          message: codespacesResponse.codespaces.length > 0
            ? `${codespacesResponse.codespaces.length} active codespace(s) available for code execution`
            : "No active codespaces found. Use 'create-github-codespace' tool to create one.  After that make sure to use the fetch-environment-and-resources tool to get the environment variables and resources available to you before you write and execute the code",
          activeCodespaces: codespacesResponse.codespaces.map((cs: any) => ({
            name: cs.name,
            state: cs.state,
            web_url: cs.web_url,
            created_at: cs.created_at,
            last_used_at: cs.last_used_at
          }))
        };
      } else {
        codespaceStatus.message = `Error checking codespaces: ${codespacesResponse.error?.message || 'Unknown error'}`;
      }
    } catch (error) {
      codespaceStatus.message = `Error checking codespaces: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }

    // Throw MCP error if no active codespaces are available
    if (!codespaceStatus.available) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "❌ CODESPACE ERROR: No active GitHub codespaces found. Please use the 'create-github-codespace' tool to create one before running security evaluation."
          }
        ]
      };
    }

    let activeCodespace = codespaceStatus.activeCodespaces[0];
    let codespacesPortUrl = generateCodespacePortUrl(activeCodespace, 3000);
    
    // Create plan object
    const resources = await fetchKeyNameAndResources({ codespaceUrl: codespacesPortUrl, githubPatToken });
    const plan = {
      researchCompleted: researched_web_context,
      contextResearchRequired: context_or_documentation_helpful,
      createdAt: new Date().toISOString(),
      generalGuidelinesAndInstructionsUsingThisToolSystem: instructions,
      status: 'planned'
    };
    
    // Store the plan
    executionCodeCollection[defaultUserId][planningToken].plan = plan;

    if (context_or_documentation_helpful && !researched_web_context) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              instruction: "❌ RESEARCH REQUIRED: Task is complex or unknown and requires web research for context or documentation. Please use the 'search-web' tool first, then create a new plan with researched_web_context=true.",
              resources: resources,
              generalGuidelinesAndInstructionsUsingThisToolSystem: instructions
            }, null, 2)
          }
        ]
      };
    }
    
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            availableResources: resources,
            planningToken: planningToken,
            plan: plan,
            tokenInfo: {
              singleUse: true,
              message: "This planning token can be used ONCE for evaluation. Create a new planning token for each evaluation."
            }
          }, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "initialize-llm",
  "Initialize the Local LLM service (Ollama with Gemma model) on the active codespace. This should be run before performing code analysis.",
  async () => {
    try {
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

// Script Management Tools
server.tool(
  "save-script-template",
  "Save an encrypted interpolatable script template",
  SaveScriptSchema,
  async ({ name, description, schema, script, tags = [] }) => {
    try {
      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)

      let token = tokens.token;
      const result = await saveScriptTemplate({
        name,
        description,
        schema,
        script,
        tags
      }, token);

      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Error saving script template: ${result.error}`,
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
              id: result.id,
              message: "Script template saved successfully",
              name,
              description,
              variables: script.match(/\{\{\s*(\w+)\s*\}\}/g) || [],
              tags
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
            text: `❌ Error saving script template: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get-script-template",
  "Retrieve and decrypt a script template by ID",
  GetScriptSchema,
  async ({ id }) => {
    try {
      const defaultUserId = "keyboard-mcp-user";
      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)

      let token = tokens.token;
      const result = await getScriptTemplate(id, token);

      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Error retrieving script template: ${result.error}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.script, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `❌ Error retrieving script template: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "list-script-templates",
  "List all script templates for the current user, optionally filtered by tags",
  ListScriptsSchema,
  async ({ tags }) => {
    try {
      const defaultUserId = "keyboard-mcp-user";
      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)
      let token = tokens.token;
      const result = await listScriptTemplates(token, tags);

      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Error listing script templates: ${result.error}`,
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
              count: result.scripts?.length || 0,
              scripts: result.scripts || [],
              filteredByTags: tags ? tags : null
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
            text: `❌ Error listing script templates: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "update-script-template",
  "Update an existing script template",
  UpdateScriptSchema,
  async ({ id, name, description, schema, script, tags }) => {
    try {
      const defaultUserId = "keyboard-mcp-user";
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (schema !== undefined) updates.schema = schema;
      if (script !== undefined) updates.script = script;
      if (tags !== undefined) updates.tags = tags;

      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)
      let token = tokens.token;
      const result = await updateScriptTemplate(id, token, updates);

      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Error updating script template: ${result.error}`,
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
              message: "Script template updated successfully",
              id,
              updates
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
            text: `❌ Error updating script template: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "delete-script-template",
  "Delete a script template by ID",
  DeleteScriptSchema,
  async ({ id }) => {
    try {
      const defaultUserId = "keyboard-mcp-user";
      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)
      let token = tokens.token;
      const result = await deleteScriptTemplate(id, token);

      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Error deleting script template: ${result.error}`,
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
              message: "Script template deleted successfully",
              id
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
            text: `❌ Error deleting script template: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "search-script-templates",
  "Search script templates by name or description",
  SearchScriptsSchema,
  async ({ searchTerm }) => {
    try {
      const defaultUserId = "keyboard-mcp-user";
      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)
      let token = tokens.token;
      const result = await searchScriptTemplates(token, searchTerm);

      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Error searching script templates: ${result.error}`,
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
              searchTerm,
              count: result.scripts?.length || 0,
              scripts: result.scripts || []
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
            text: `❌ Error searching script templates: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "interpolate-script",
  "Interpolate a script template with provided variables and return the executable code",
  InterpolateScriptSchema,
  async ({ id, variables }) => {
    try {
      const defaultUserId = "keyboard-mcp-user";
      // First, get the script template
      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)
      let token = tokens.token;
      const templateResult = await getScriptTemplate(id, token);

      if (!templateResult.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Error retrieving script template: ${templateResult.error}`,
            },
          ],
        };
      }

      const script = templateResult.script!;
      
      // Interpolate the template
      const interpolated = interpolateScript(script.script, variables);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              scriptId: id,
              scriptName: script.name,
              scriptDescription: script.description,
              template: script.script,
              variables: variables,
              interpolatedCode: interpolated.interpolated,
              availableVariables: Object.keys(script.schema || {}),
              tags: script.tags
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
            text: `❌ Error interpolating script: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "evaluate_using_shortcut",
  "Evaluate a saved script template by interpolating it with provided variables. This bypasses the planning token requirement and directly creates an execution token for the interpolated script.",
  {
    script_id: z.string().describe("ID of the saved script template to use"),
    variables: z.record(z.string(), z.any()).describe("Variables to interpolate into the script template"),
    explanation_of_usage: z.string().describe("A brief explanation of how you're using this script and what it will accomplish")
  },
  async ({ script_id, variables, explanation_of_usage }) => {
    try {
      const defaultUserId = "keyboard-mcp-user";
      
      // Get the script template
      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)
      let token = tokens.token;
      const templateResult = await getScriptTemplate(script_id, token);
      if (!templateResult.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ Error retrieving script template: ${templateResult.error}`,
            },
          ],
        };
      }

      const script = templateResult.script!;
      
      // Interpolate the template with variables
      const interpolated = interpolateScript(script.script, variables);
      
      // Generate execution token for the interpolated script
      const executionToken = generateExecutionToken(defaultUserId);
      
      // Store the interpolated code in the execution collection
      executionCodeCollection[defaultUserId][executionToken] = {
        status: 'approved',
        code: interpolated.interpolated,
        explanation: `${explanation_of_usage}\n\nUsing script template: ${script.name}\nDescription: ${script.description}`,
        timestamp: new Date().toISOString(),
        templateId: script_id,
        templateName: script.name,
        variables: variables
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "✅ Script template evaluated and execution token generated",
              executionToken: executionToken,
              scriptTemplate: {
                id: script_id,
                name: script.name,
                description: script.description,
                tags: script.tags
              },
              interpolatedCode: interpolated.interpolated,
              variables: variables,
              explanation: explanation_of_usage,
              instructions: [
                "Your script has been evaluated and is ready for execution",
                `Use the execution token '${executionToken}' with the 'execute' tool`,
                "This bypassed the planning phase since you used a pre-saved script template"
              ]
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
            text: `❌ Error evaluating script template: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);



async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});