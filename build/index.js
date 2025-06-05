import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import 'dotenv/config';
const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";
let githubPatToken = process.env.GITHUB_PAT_TOKEN || "";
// Create server instance
const server = new McpServer({
    name: "keyboard-mcp",
    version: "1.0.0",
    capabilities: {
        resources: {},
        tools: {},
    },
});
// Helper function for making NWS API requests
async function makeNWSRequest(url) {
    const headers = {
        "User-Agent": USER_AGENT,
        Accept: "application/geo+json",
    };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return (await response.json());
    }
    catch (error) {
        console.error("Error making NWS request:", error);
        return null;
    }
}
// Format alert data
function formatAlert(feature) {
    const props = feature.properties;
    return [
        `Event: ${props.event || "Unknown"}`,
        `Area: ${props.areaDesc || "Unknown"}`,
        `Severity: ${props.severity || "Unknown"}`,
        `Status: ${props.status || "Unknown"}`,
        `Headline: ${props.headline || "No headline"}`,
        "---",
    ].join("\n");
}
const createInteractiveDocsCodespace = async ({ token, }) => {
    try {
        const body = {
            "owner": "docsdeveloperdemo",
            "repo": "codespace-executor",
            "branch": "main"
        };
        const { owner, repo, branch = "main" } = body;
        const octokit = new Octokit({
            auth: token,
        });
        const response = await octokit.rest.codespaces.createWithRepoForAuthenticatedUser({
            owner,
            repo,
            ref: branch,
            location: "WestUs2",
            machine: "basicLinux32gb",
        });
        return {
            success: true,
            codespace: response.data,
            url: response.data.web_url,
        };
    }
    catch (e) {
        if (e && typeof e === 'object' && 'response' in e) {
            const error = e;
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
const listActiveCodespacesForRepo = async ({ token, repo = "codespace-executor", }) => {
    try {
        const octokit = new Octokit({
            auth: token,
        });
        const response = await octokit.rest.codespaces.listForAuthenticatedUser();
        // Filter codespaces by repo name and only include active ones
        const matchingCodespaces = response.data.codespaces.filter(codespace => codespace.repository?.name === repo &&
            codespace.state === 'Available');
        return {
            success: true,
            codespaces: matchingCodespaces,
            count: matchingCodespaces.length,
        };
    }
    catch (e) {
        if (e && typeof e === 'object' && 'response' in e) {
            const error = e;
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
const generateCodespacePortUrl = (codespace, port = 3000) => {
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
    }
    catch (error) {
        return `Error generating port URL: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
};
const executeCodeOnCodespace = async ({ codespaceUrl, code, environmentVariablesNames, docResources, token, }) => {
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
    }
    catch (e) {
        return {
            success: false,
            error: {
                message: e instanceof Error ? e.message : 'Unknown error occurred'
            }
        };
    }
};
const fetchKeyNameAndResources = async ({ codespaceUrl, githubPatToken }) => {
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
    }
    catch (e) {
        return {
            success: false,
            error: {
                message: e instanceof Error ? e.message : 'Unknown error occurred'
            }
        };
    }
};
const stopCodespace = async ({ codespaceName, token, }) => {
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
    }
    catch (e) {
        if (e && typeof e === 'object' && 'response' in e) {
            const error = e;
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
server.tool("create-github-codespace", "create a github codespace", async () => {
    const response = await createInteractiveDocsCodespace({
        token: githubPatToken
    });
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(response),
            },
        ],
    };
});
server.tool("list-active-codespaces", "List active GitHub codespaces for the codespace-executor repo", async () => {
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
});
server.tool("get-codespace-port-urls", "Get active codespaces for codespace-executor repo with port 3000 URLs", async () => {
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
    const codespacesWithUrls = response.codespaces.map((codespace) => ({
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
});
server.tool("execute-code-on-codespace", "Execute code on a specific codespace using its port 3000 URL", {
    codespace_url: z.string().describe("The codespace port 3000 URL (e.g., https://username-repo-abc123-3000.app.github.dev)"),
    code: z.string().describe("The JavaScript/Node.js code to execute"),
    environmentVariablesNames: z.array(z.string()).describe("The names of known environment variables in the codespace we can use in the code"),
    installPackages: z.array(z.string()).describe("the list of npm packages already installed in the codespace we can use in the code"),
    relevantDocs: z.array(z.string()).describe("The relevant docs to inform the code to execute"),
}, async ({ codespace_url, code, environmentVariablesNames, installPackages, relevantDocs }) => {
    const response = await executeCodeOnCodespace({
        codespaceUrl: codespace_url,
        code: code,
        environmentVariablesNames,
        docResources: relevantDocs,
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
});
server.tool("execute-code-on-active-codespace", "Find the first active codespace-executor codespace and execute code on it", {
    code: z.string().describe("The JavaScript/Node.js code to execute"),
    environmentVariablesNames: z.array(z.string()).describe("The names of known environment variables in the codespace we can use in the code"),
    installPackages: z.array(z.string()).describe("the list of npm packages already installed in the codespace we can use in the code"),
    relevantDocs: z.array(z.string()).describe("The relevant docs to inform the code to execute")
}, async ({ code, environmentVariablesNames, installPackages, relevantDocs }) => {
    // First, get active codespaces
    const codespacesResponse = await listActiveCodespacesForRepo({
        token: githubPatToken
    });
    if (!codespacesResponse.success) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: "Failed to fetch active codespaces",
                        details: codespacesResponse
                    }, null, 2),
                },
            ],
        };
    }
    if (codespacesResponse.codespaces.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: "No active codespaces found for codespace-executor repo"
                    }, null, 2),
                },
            ],
        };
    }
    // Use the first active codespace
    const firstCodespace = codespacesResponse.codespaces[0];
    const port3000Url = generateCodespacePortUrl(firstCodespace, 3000);
    if (port3000Url.startsWith('Error')) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: `Trying using the fetch-environment-and-resources tool to get the environment variables and resources available to you before you write and execute the code`
                    }, null, 2),
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
    let messageFromTheCodespace;
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    codespace_used: {
                        name: firstCodespace.name,
                        url: port3000Url
                    },
                    execution_result: executeResponse
                }, null, 2),
            },
        ],
    };
});
server.tool("fetch-environment-and-resources", "If you need to use any code that requires a specific npm or sdk or an API key, use this to check what is available to you before you write and execute the code", async () => {
    // First, get active codespaces
    const codespacesResponse = await listActiveCodespacesForRepo({
        token: githubPatToken
    });
    if (!codespacesResponse.success) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: "Failed to fetch active codespaces",
                        details: codespacesResponse
                    }, null, 2),
                },
            ],
        };
    }
    if (codespacesResponse.codespaces.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: "No active codespaces found for codespace-executor repo"
                    }, null, 2),
                },
            ],
        };
    }
    // Use the first active codespace
    const firstCodespace = codespacesResponse.codespaces[0];
    const codespacesPortUrl = generateCodespacePortUrl(firstCodespace, 3000);
    if (codespacesPortUrl.startsWith('Error')) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: codespacesPortUrl
                    }, null, 2),
                },
            ],
        };
    }
    // Fetch key names and resources
    const response = await fetchKeyNameAndResources({ codespaceUrl: codespacesPortUrl, githubPatToken });
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
});
server.tool("stop-codespace", "Stop a specific GitHub codespace by name", {
    codespace_name: z.string().describe("The name of the codespace to stop"),
}, async ({ codespace_name }) => {
    const response = await stopCodespace({
        codespaceName: codespace_name,
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
});
server.tool("stop-active-codespace", "Find and stop the first active codespace-executor codespace", async () => {
    // First, get active codespaces
    const codespacesResponse = await listActiveCodespacesForRepo({
        token: githubPatToken
    });
    if (!codespacesResponse.success) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: "Failed to fetch active codespaces",
                        details: codespacesResponse
                    }, null, 2),
                },
            ],
        };
    }
    if (codespacesResponse.codespaces.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: "No active codespaces found for codespace-executor repo"
                    }, null, 2),
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
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Weather MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
