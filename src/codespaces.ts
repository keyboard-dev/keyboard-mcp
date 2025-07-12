import { WebSocketManager, WebSocketMessage } from './approver.js';
import { Octokit } from "@octokit/rest";
import 'dotenv/config'
let encryptMessages = process.env.ENCRYPT_MESSAGES || true
let customAPIPort = process.env.CUSTOM_API_PORT || 8081
import axios from 'axios'
import { any } from 'zod/v4';

const encryptMessage = async (code: string, token: string) => {
  const response = await axios.post(`http://127.0.0.1:${customAPIPort}/api/encrypt`, { code }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
  });
  console.warn("response", response)
  return response.data.encryptedCode;
}

const decryptMessage = async (code: string, token: string) => {
  const response = await axios.post(`http://127.0.0.1:${customAPIPort}/api/decrypt`, { code }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
  });
  console.warn("response", response)
  return response.data.decryptedCode;
}

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
  wsManager?: WebSocketManager | null;
  userId?: string;
  aiEvalSettings?: boolean;
}

interface Repository {
  name: string;
  full_name: string;
  owner: {
    login: string;
    type: string;
  };
  private: boolean;
}

export const findCodespaceExecutorRepos = async (token: string): Promise<any | Error> => {
  try {
    const octokit = new Octokit({
      auth: token,
    });

    // Get all repositories for the authenticated user
    const response = await octokit.rest.repos.listForAuthenticatedUser({
      per_page: 100, // Maximum per page
      sort: 'updated',
      direction: 'desc'
    });

    // Filter repositories that contain "codespace-executor" in the name
    const codespaceRepos = response.data.filter((repo: Repository) =>
      repo.name.toLowerCase().includes('codespace-executor')
    );

    // Also check user's organizations for codespace-executor repos
    let orgRepos: Repository[] = [];
    try {
      const orgsResponse = await octokit.rest.orgs.listForAuthenticatedUser();

      for (const org of orgsResponse.data) {
        const orgReposResponse = await octokit.rest.repos.listForOrg({
          org: org.login,
          per_page: 100
        });

        const orgCodespaceRepos = orgReposResponse.data.filter((repo: Repository) =>
          repo.name.toLowerCase().includes('codespace-executor')
        );

        orgRepos = orgRepos.concat(orgCodespaceRepos);
      }
    } catch (orgError) {
      console.warn('Could not fetch organization repositories:', orgError);
      // Continue without org repos if there's an error
    }

    const allCodespaceRepos = [...codespaceRepos, ...orgRepos];

    // Test codespace access for each found repository
    const reposWithCodespaceAccess: any = [];
    const reposWithoutCodespaceAccess = [];

    for (const repo of allCodespaceRepos) {
      try {
        // Try to get available machines for the repository - this tests codespace access
        await octokit.rest.codespaces.repoMachinesForAuthenticatedUser({
          owner: repo.owner.login,
          repo: repo.name,
        });

        reposWithCodespaceAccess.push({
          ...repo,
          codespaceAccess: true
        });
      } catch (error: any) {
        // If we get a 404 or 403, the repo doesn't have codespace access
        reposWithoutCodespaceAccess.push({
          ...repo,
          codespaceAccess: false,
          error: error.message || 'Access denied'
        });
      }
    }

    return {
      success: true,
      repositories: reposWithCodespaceAccess, // Only return repos with codespace access
      allFoundRepos: allCodespaceRepos, // All found repos regardless of access
      count: reposWithCodespaceAccess.length,
      totalFound: allCodespaceRepos.length,
      userRepos: codespaceRepos.filter(repo =>
        reposWithCodespaceAccess.some((accessRepo: any) => accessRepo.full_name === repo.full_name)
      ),
      orgRepos: orgRepos.filter(repo =>
        reposWithCodespaceAccess.some((accessRepo: any) => accessRepo.full_name === repo.full_name)
      ),
      accessSummary: {
        withAccess: reposWithCodespaceAccess.length,
        withoutAccess: reposWithoutCodespaceAccess.length,
        reposWithoutAccess: reposWithoutCodespaceAccess
      }
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


export const createInteractiveDocsCodespace = async ({
  token,
  branch = "main"
}: CreateCodespaceParams): Promise<any | Error> => {
  let actualOwner = 'keyboard-dev';
  let actualRepo = 'codespace-executor';
  let allRepos = []

  try {

    // Determine the actual owner and repo to use

    // If no owner/repo specified, try to find codespace-executor repos

    const repoSearchResult = await findCodespaceExecutorRepos(token);
    allRepos = repoSearchResult.repositories || [];

    if (!repoSearchResult.success) {
      return {
        success: false,
        error: {
          message: 'Failed to search for codespace-executor repositories: ' + repoSearchResult.error?.message
        }
      };
    }

    if (repoSearchResult.repositories && repoSearchResult.repositories.length > 0) {
      // Use the first found codespace-executor repo
      const foundRepo = repoSearchResult.repositories[0];
      actualOwner = foundRepo.owner.login;
      actualRepo = foundRepo.name;
    } else {
      // Return error if no codespace-executor repos found - user needs to fork first
      return {
        success: false,
        error: {
          message: 'No codespace-executor repository found in your account. Please fork https://github.com/keyboard-dev/codespace-executor first, then try again.'
        }
      };
    }

    const body = {
      "owner": actualOwner,
      "repo": actualRepo,
      "branch": branch,

    }

    const { owner: bodyOwner, repo: bodyRepo, branch: bodyBranch = "main" } = body;



    const octokit = new Octokit({
      auth: token,
    });

    // First, get available machine types for the repository
    let machinesResponse;
    let availableMachines: any[] = [];
    try {
      machinesResponse = await octokit.rest.codespaces.repoMachinesForAuthenticatedUser({
        owner: bodyOwner,
        repo: bodyRepo,
      });
      availableMachines = machinesResponse.data.machines;
    } catch (error) {
      // If the repo doesn't exist, we can still create a codespace with default machine
      console.warn(`Could not fetch machines for repo ${bodyOwner}/${bodyRepo}:`, error);
    }




    // Check if premiumLinux is available, otherwise use standardLinux32gb
    let selectedMachine = "standardLinux32gb"; // default fallback
    if (availableMachines.some(machine => machine?.name === "premiumLinux")) {
      selectedMachine = "premiumLinux";
    }

    // if (availableMachines.some(machine => machine.name === "premiumLinux")) {
    //   selectedMachine = "premiumLinux";
    // }

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
      availableMachines: machinesResponse?.data,
      foundRepoInfo: { owner: actualOwner, repo: actualRepo }
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'response' in e) {
      const error = e as { response: { headers: any; status: number }; message: string };
      return {
        success: false,
        error: {
          message: error.message,
          owner: actualOwner,
          repo: actualRepo,
          repos: allRepos,
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

export const listActiveCodespacesForRepo = async ({
  token,
  repo,
}: ListCodespacesParams): Promise<any | Error> => {
  try {
    const octokit = new Octokit({
      auth: token,
    });

    const response = await octokit.rest.codespaces.listForAuthenticatedUser();

    // If no repo specified, try to find codespace-executor repos
    let repoNames: string[] = [];
    if (!repo) {
      const repoSearchResult = await findCodespaceExecutorRepos(token);

      if (repoSearchResult.success && repoSearchResult.repositories && repoSearchResult.repositories.length > 0) {
        repoNames = repoSearchResult.repositories.map((r: Repository) => r.name);
      } else {
        return {
          success: false,
          error: {
            message: 'No codespace-executor repository found in your account. Please fork https://github.com/keyboard-dev/codespace-executor first, then try again.'
          }
        };
      }
    } else {
      repoNames = [repo];
    }

    // Filter codespaces by repo names and only include active ones
    const matchingCodespaces = response.data.codespaces.filter((codespace: any) =>
      repoNames.includes(codespace.repository?.name) &&
      codespace.state === 'Available'
    );

    if (matchingCodespaces.length === 0) {
      return {
        success: false,
        error: {
          message: 'No active codespaces found for the codespace-executor repository. Please create a codespace first, or if you haven\'t forked the repository, please fork https://github.com/keyboard-dev/codespace-executor first.',
        }
      }
    }

    return {
      success: true,
      codespaces: matchingCodespaces,
      count: matchingCodespaces.length,
      searchedRepos: repoNames,
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

export const listAllCodespacesForRepo = async ({
  token,
  repo,
}: ListCodespacesParams): Promise<any | Error> => {
  try {
    const octokit = new Octokit({
      auth: token,
    });

    const response = await octokit.rest.codespaces.listForAuthenticatedUser();

    // If no repo specified, try to find codespace-executor repos
    let repoNames: string[] = [];
    if (!repo) {
      const repoSearchResult = await findCodespaceExecutorRepos(token);

      if (repoSearchResult.success && repoSearchResult.repositories && repoSearchResult.repositories.length > 0) {
        repoNames = repoSearchResult.repositories.map((r: Repository) => r.name);
      } else {
        return {
          success: false,
          error: {
            message: 'No codespace-executor repository found in your account. Please fork https://github.com/keyboard-dev/codespace-executor first, then try again.'
          }
        };
      }
    } else {
      repoNames = [repo];
    }

    // Filter codespaces by repo names (include all states)
    const matchingCodespaces = response.data.codespaces.filter((codespace: any) =>
      repoNames.includes(codespace.repository?.name)
    );

    // Group by state for better organization
    const codespacesGroupedByState = matchingCodespaces.reduce((acc: any, codespace: any) => {
      const state = codespace.state || 'Unknown';
      if (!acc[state]) {
        acc[state] = [];
      }
      acc[state].push(codespace);
      return acc;
    }, {});

    return {
      success: true,
      codespaces: matchingCodespaces,
      count: matchingCodespaces.length,
      groupedByState: codespacesGroupedByState,
      statesSummary: Object.keys(codespacesGroupedByState).map(state => ({
        state,
        count: codespacesGroupedByState[state].length
      })),
      searchedRepos: repoNames,
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

export const generateCodespacePortUrl = (codespace: any, port: number = 3000): string => {
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

export const executeCodeOnCodespace = async ({
  codespaceUrl,
  code,
  token,
  wsManager,
  userId = "unknown_user",
  aiEvalSettings = false
}: ExecuteCodeParams): Promise<any | Error> => {
  try {
    if (!codespaceUrl) {
      throw new Error("Codespace URL is required");
    }
    if (!code) {
      throw new Error("Code is required");
    }

    // Log websocket status for debugging
    if (!wsManager && !aiEvalSettings) {
    }

    if (aiEvalSettings) wsManager = null

    const executeUrl = `${codespaceUrl}/execute`;
    let userToken;
    if (encryptMessages) {
      let tokens = await wsManager?.sendAndWaitForTokenResponse({
        "type": "request-token",
        "requestId": "optional-unique-id"
      }, 3000)

      userToken = tokens.token;
      const encryptedCode = await encryptMessage(code, userToken);
      console.warn("encryptedCode", encryptedCode)
      code = encryptedCode;
    }

    const requestBody = JSON.stringify({
      code: code,
      ai_eval: aiEvalSettings,
      encrypt_messages: encryptMessages
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

    const responseData: any = await response.json();
    let responseBody = responseData || { "success": false, "error": "No response from codespace" }

    let approvalMessage = {
      id: `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      title: "code response approval",
      body: `Here is the response from the codespace: ${JSON.stringify(responseBody)}`,
      timestamp: Date.now(),
      priority: "normal",
      sender: "MCP Client",
      status: 'pending',
      type: "notification_message",
      requiresResponse: true
    };

    if (encryptMessages) {
      let decryptedResponseBody;
      try {
        console.warn("responseBody", responseBody)
        decryptedResponseBody = await decryptMessage(responseBody.data, userToken)
        console.warn("decryptedResponseBody", decryptedResponseBody)
      } catch (e) {
        //console.warn("error parsing responseBody", e)
      }
      if (decryptedResponseBody) {
        approvalMessage.body = `Here is the response from the codespace: ${decryptedResponseBody}`
      }
    }

    let responseToSend = null;
    if (!aiEvalSettings && wsManager) {
      let webSocketResponse = await wsManager.sendAndWaitForApproval(
        approvalMessage,
        300000
      );
      responseToSend = webSocketResponse
    } else if (!aiEvalSettings && !wsManager) {
      // No websocket manager available, provide manual approval message
      responseToSend = {
        status: 'manual_approval_required',
        message: 'WebSocket connection unavailable. Please review the execution result manually.',
        timestamp: Date.now(),
        sender: 'MCP System',
        executionResult: responseBody,
        note: 'This execution completed but could not be automatically approved due to missing WebSocket connection.'
      };
    } else {
      if (responseData?.data?.aiAnalysis) {
        try {
          let aiAnalysis = JSON.parse(responseData.data.aiAnalysis);
          if (aiAnalysis?.VISIBLE_HARD_CODED_API_KEY_OR_RAW_SENSITIVE_DATA === false) {
            // AI analysis says code is safe - no sensitive data exposed
            responseToSend = {
              status: 'approved',
              message: 'AI analysis approved - no sensitive data detected',
              timestamp: Date.now(),
              sender: 'AI Security System',
              aiAnalysis: aiAnalysis,
              ...responseData.data
            };
          } else {
            throw new Error("AI analysis found potential sensitive data exposure. Please review the code and try again.");
          }
        } catch (parseError) {
          throw new Error(`Failed to parse AI analysis: ${parseError instanceof Error ? parseError.message : 'Unknown parsing error'}`);
        }
      } else {
        throw new Error("AI analysis was not provided in the response.");
      }
    }


    console.warn("webSocketResponse")

    return {
      success: true,
      webSocketResponse: responseToSend,
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

export const fetchKeyNameAndResources = async ({ codespaceUrl, githubPatToken }: { codespaceUrl: string, githubPatToken: string }): Promise<any | Error> => {
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

export const stopCodespace = async ({
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

export const deleteCodespace = async ({
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

    const response = await octokit.rest.codespaces.deleteForAuthenticatedUser({
      codespace_name: codespaceName,
    });

    return {
      success: true,
      message: `Codespace ${codespaceName} has been deleted`,
      status: response.status,
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

export const getLocalLLMStatus = async (codespaceBaseUrl?: string, githubPatToken?: string): Promise<any | Error> => {
  try {
    const statusUrl = `${codespaceBaseUrl}/local-llm/status`
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${githubPatToken}`,
        'x-github-token': `${githubPatToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
    }
    const result: any = await response.json();
    return {
      success: result.success || false,
      message: result.message || 'Local LLM status retrieved',
      status: result.status,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred during Local LLM status retrieval',
    };
  }
};


export const initializeLocalLLM = async (codespaceBaseUrl?: string, githubPatToken?: string): Promise<any | Error> => {
  try {
    // Generate the initialize URL - either from codespace or fallback to localhost
    if (!codespaceBaseUrl) {
      throw new Error('Codespace base URL is required');
    }
    if (!githubPatToken) {
      throw new Error('GitHub PAT token is required');
    }
    const initUrl = `${codespaceBaseUrl}/local-llm/initialize`


    const response = await fetch(initUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${githubPatToken}`,
        'x-github-token': `${githubPatToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
    }

    const result: any = await response.json();
    return {
      success: result.success || false,
      message: result.message || 'LLM initialization completed',
      status: result.status,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred during LLM initialization',
    };
  }
};