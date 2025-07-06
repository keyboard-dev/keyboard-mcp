/**
 * Security Analysis Module using Ollama/Gemma on GitHub Codespace
 * 
 * This module provides AI-powered security analysis capabilities
 * for detecting malicious code and environment variable exposure.
 */

// Interface for code analysis result
export interface CodeAnalysisResult {
  success: boolean;
  analysis?: string;
  errors?: string[];
  suggestions?: string[];
  security_issues?: string[];
  performance_notes?: string[];
  environment_exposure_risk?: string;
  malicious_code_detected?: boolean;
  threat_level?: string;
  error?: string;
}

// Interface for LLM initialization result
export interface LLMInitResult {
  success: boolean;
  message?: string;
  status?: any;
  error?: string;
}

/**
 * Initializes the Local LLM service (Ollama with Gemma model)
 * This function starts the LLM service and ensures the model is ready
 */
export const initializeLocalLLM = async (codespaceBaseUrl?: string, githubPatToken?: string): Promise<LLMInitResult> => {
  try {
    // Generate the initialize URL - either from codespace or fallback to localhost
    const initUrl = codespaceBaseUrl 
      ? `${codespaceBaseUrl}/local-llm/initialize`
      : 'http://localhost:3000/local-llm/initialize';

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

    const result = await response.json();
    
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

/**
 * Gets the status of the Local LLM service
 */
export const getLLMStatus = async (codespaceBaseUrl?: string, githubPatToken?: string): Promise<any> => {
  try {
    // Generate the status URL - either from codespace or fallback to localhost
    const statusUrl = codespaceBaseUrl 
      ? `${codespaceBaseUrl}/local-llm/status`
      : 'http://localhost:3000/local-llm/status';

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

    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred while checking LLM status',
    };
  }
};

/**
 * Analyzes code using Ollama with gemma3:1b model running on GitHub Codespace
 * Focuses primarily on security analysis, malicious code detection, 
 * and environment variable exposure detection.
 */
export const analyzeCodeWithGemma = async (
  code: string, 
  codespaceBaseUrl?: string,
  githubPatToken?: string
): Promise<any> => {
  let responseString = null;
  try {
    // Generate the Ollama URL - either from codespace or fallback to localhost
    const ollamaUrl = `${codespaceBaseUrl}/api/chat`

    console.error(`🔍 Connecting to Ollama at: ${ollamaUrl}`);

    const requestBody = {
      model: "gemma3:1b",
      messages: [
        { 
          role: "user", 
          content: `Check if the code console.logs or returns any process.env variables: \n\n ${code} \n\n Please just return a JSON {answer: "yes" or "no"} with no other commentary`
        }
      ],
      stream: false
    };

    const response = await fetch(ollamaUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${githubPatToken}`,
        'x-github-token': `${githubPatToken}`
      },
      body: JSON.stringify(requestBody)
    });

    responseString = JSON.stringify(requestBody);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
    }
 
    const responseData = await response.json();
  
    
    return {...responseData.message?.content, sendMessagesString: responseString}
  } catch (error) {
    return {
      success: false,
      sendMessagesString: responseString,
      error: error instanceof Error ? error.message : 'Unknown error occurred during security analysis',
    };
  }
}; 