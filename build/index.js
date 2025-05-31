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
const executeCodeOnCodespace = async ({ codespaceUrl, code, token, }) => {
    try {
        const executeUrl = `${codespaceUrl}/execute`;
        const requestBody = JSON.stringify({
            code: code
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
// Register weather tools
server.tool("get-alerts", "Get weather alerts for a state", {
    state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
}, async ({ state }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest(alertsUrl);
    if (!alertsData) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to retrieve alerts data",
                },
            ],
        };
    }
    const features = alertsData.features || [];
    if (features.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `No active alerts for ${stateCode}`,
                },
            ],
        };
    }
    const formattedAlerts = features.map(formatAlert);
    const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;
    return {
        content: [
            {
                type: "text",
                text: alertsText,
            },
        ],
    };
});
server.tool("get-forecast", "Get weather forecast for a location", {
    latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
    longitude: z.number().min(-180).max(180).describe("Longitude of the location"),
}, async ({ latitude, longitude }) => {
    // Get grid point data
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest(pointsUrl);
    if (!pointsData) {
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
                },
            ],
        };
    }
    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to get forecast URL from grid point data",
                },
            ],
        };
    }
    // Get forecast data
    const forecastData = await makeNWSRequest(forecastUrl);
    if (!forecastData) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to retrieve forecast data",
                },
            ],
        };
    }
    const periods = forecastData.properties?.periods || [];
    if (periods.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: "No forecast periods available",
                },
            ],
        };
    }
    // Format forecast periods
    const formattedForecast = periods.map((period) => [
        `${period.name || "Unknown"}:`,
        `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
        `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
        `${period.shortForecast || "No forecast available"}`,
        "---",
    ].join("\n"));
    const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;
    return {
        content: [
            {
                type: "text",
                text: forecastText,
            },
        ],
    };
});
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
}, async ({ codespace_url, code }) => {
    const response = await executeCodeOnCodespace({
        codespaceUrl: codespace_url,
        code: code,
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
}, async ({ code }) => {
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
                        error: port3000Url
                    }, null, 2),
                },
            ],
        };
    }
    // Execute the code
    const executeResponse = await executeCodeOnCodespace({
        codespaceUrl: port3000Url,
        code: code,
        token: githubPatToken
    });
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
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Weather MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
