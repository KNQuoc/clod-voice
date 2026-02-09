import fetch from 'node-fetch';

export class OpenClawBridge {
    private gatewayUrl: string;
    private token: string;

    constructor(gatewayUrl: string, token: string) {
        this.gatewayUrl = gatewayUrl;
        this.token = token;
    }

    async askClaude(message: string): Promise<string> {
        try {
            // Send message to OpenClaw gateway
            const response = await fetch(`${this.gatewayUrl}/api/sessions/send`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: message,
                    session_id: 'main' // Use main session
                })
            });

            if (!response.ok) {
                throw new Error(`OpenClaw API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as any;
            
            // Extract the text response from Claude
            if (data.response && data.response.text) {
                return data.response.text;
            } else if (data.message) {
                return data.message;
            } else {
                return data.toString();
            }
        } catch (error) {
            console.error('Error communicating with OpenClaw:', error);
            return `Sorry, I encountered an error while trying to process your request: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    async checkEmail(): Promise<string> {
        return this.askClaude("Check my email for any urgent or important messages. Summarize what you find.");
    }

    async checkCalendar(): Promise<string> {
        return this.askClaude("Check my calendar for today and tomorrow. Tell me about any upcoming events or meetings.");
    }

    async searchWeb(query: string): Promise<string> {
        return this.askClaude(`Search the web for: ${query}`);
    }

    async runCommand(command: string): Promise<string> {
        return this.askClaude(`Please run this command: ${command}`);
    }
}

// Function definitions for OpenAI Realtime API
export const openClawFunctions = [
    {
        type: "function" as const,
        name: "ask_claude",
        description: "Route a request to Claude (OpenClaw) for tasks requiring tools like email, calendar, web search, file management, running commands, or anything that needs external integrations.",
        parameters: {
            type: "object",
            properties: {
                message: {
                    type: "string",
                    description: "The user's request to forward to Claude"
                }
            },
            required: ["message"]
        }
    },
    {
        type: "function" as const,
        name: "check_email",
        description: "Check for urgent or important email messages",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        type: "function" as const,
        name: "check_calendar",
        description: "Check calendar for today and tomorrow's events",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        type: "function" as const,
        name: "search_web",
        description: "Search the web for information",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The search query"
                }
            },
            required: ["query"]
        }
    },
    {
        type: "function" as const,
        name: "run_command",
        description: "Run a command or perform system operations",
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The command to run"
                }
            },
            required: ["command"]
        }
    }
];

export async function handleFunctionCall(
    bridge: OpenClawBridge,
    functionName: string,
    args: any
): Promise<string> {
    switch (functionName) {
        case "ask_claude":
            return bridge.askClaude(args.message);
        case "check_email":
            return bridge.checkEmail();
        case "check_calendar":
            return bridge.checkCalendar();
        case "search_web":
            return bridge.searchWeb(args.query);
        case "run_command":
            return bridge.runCommand(args.command);
        default:
            return `Unknown function: ${functionName}`;
    }
}