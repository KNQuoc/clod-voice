import fetch from 'node-fetch';
import { execSync } from 'child_process';

export class OpenClawBridge {
    private gatewayUrl: string;
    private token: string;

    constructor(gatewayUrl: string, token: string) {
        this.gatewayUrl = gatewayUrl;
        this.token = token;
    }

    /**
     * Quick mode: Stateless chat completions endpoint.
     * Fast-ish, has tools, but no persistent memory/context.
     */
    async askClodQuick(message: string): Promise<string> {
        try {
            const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'openclaw:main',
                    messages: [
                        {
                            role: 'user',
                            content: `[Voice request from Discord] ${message}\n\nRespond concisely — this will be read aloud.`
                        }
                    ]
                })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`OpenClaw API error: ${response.status} - ${text}`);
            }

            const data = await response.json() as any;
            if (data.choices?.[0]?.message?.content) {
                return data.choices[0].message.content;
            }
            return JSON.stringify(data);
        } catch (error) {
            console.error('Error communicating with OpenClaw (quick):', error);
            return `Sorry, I couldn't reach Clod right now: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Full mode: Chat completions with a persistent session.
     * Has full context, memory, workspace — slower but it's the real Clod.
     * Uses the `user` field to maintain a stable session across calls.
     */
    async askClodFull(message: string): Promise<string> {
        try {
            // Spawn a sub-agent task — it runs in the background and announces
            // the result in Discord. We return immediately to voice.
            const response = await fetch(`${this.gatewayUrl}/tools/invoke`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    tool: 'sessions_spawn',
                    args: {
                        task: `[Voice request from Kien] ${message}\n\nRespond concisely. Deliver your answer to Discord channel #ask-clod (channel ID: 1470503902309781595).`,
                        label: 'voice-request',
                        cleanup: 'delete'
                    }
                })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`OpenClaw API error: ${response.status} - ${text}`);
            }

            const data = await response.json() as any;
            if (data.ok) {
                return "I've sent that to Clod. He'll respond in the ask-clod Discord channel shortly.";
            }
            return `Error: ${JSON.stringify(data)}`;
        } catch (error) {
            console.error('Error communicating with OpenClaw (full):', error);
            return `Sorry, I couldn't reach Clod right now: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Invoke a specific tool directly via the gateway — fast path, no agent turn.
     */
    async invokeTool(tool: string, args: Record<string, any>): Promise<string> {
        try {
            const response = await fetch(`${this.gatewayUrl}/tools/invoke`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ tool, args })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Tool invoke error: ${response.status} - ${text}`);
            }

            const data = await response.json() as any;
            if (data.ok) {
                if (typeof data.result === 'string') return data.result;
                // Extract text content if present
                if (data.result?.content?.[0]?.text) return data.result.content[0].text;
                return JSON.stringify(data.result);
            }
            return JSON.stringify(data);
        } catch (error) {
            console.error(`Error invoking tool ${tool}:`, error);
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Run a local command directly via child_process — fastest path.
     */
    private runLocal(command: string, timeoutMs = 15000): string {
        try {
            const result = execSync(command, {
                encoding: 'utf-8',
                timeout: timeoutMs,
                env: {
                    ...process.env,
                    ZONEINFO: 'C:\\Users\\nethe\\zoneinfo.zip',
                    PATH: `C:\\Users\\nethe\\.openclaw\\bin;C:\\Users\\nethe\\.openclaw\\bin\\mingit\\cmd;${process.env.PATH}`
                }
            });
            return result.trim();
        } catch (error: any) {
            console.error('Local command error:', error.message);
            return error.stdout?.trim() || error.message || 'Command failed';
        }
    }

    async checkEmail(): Promise<string> {
        return this.runLocal('gog.exe gmail list --max 5 --unread');
    }

    async checkCalendar(): Promise<string> {
        return this.runLocal('gog.exe calendar events --days 2 --all');
    }

    async searchWeb(query: string): Promise<string> {
        return this.invokeTool('web_search', { query, count: 5 });
    }

    async runCommand(command: string): Promise<string> {
        return this.runLocal(command);
    }
}

// Function definitions for OpenAI Realtime API
export const openClawFunctions = [
    {
        type: "function" as const,
        name: "ask_clod_quick",
        description: "Quick mode: Route a request to Clod for tasks needing tool access (web search, commands, etc). Stateless — no memory of past conversations. Good for one-off questions that need tools.",
        parameters: {
            type: "object",
            properties: {
                message: {
                    type: "string",
                    description: "The request to forward to Clod"
                }
            },
            required: ["message"]
        }
    },
    {
        type: "function" as const,
        name: "ask_clod_full",
        description: "Full mode: Send a request to the REAL Clod with full context — memory, workspace, project knowledge, personal preferences. Use this for complex tasks, anything referencing past conversations, projects (like blockd4), personal context, or when the user explicitly says 'ask Clod' or needs the real assistant. Slower but much more capable. Response will be posted in Discord.",
        parameters: {
            type: "object",
            properties: {
                message: {
                    type: "string",
                    description: "The request to forward to Clod"
                }
            },
            required: ["message"]
        }
    },
    {
        type: "function" as const,
        name: "check_email",
        description: "Quickly check for recent unread emails",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        type: "function" as const,
        name: "check_calendar",
        description: "Quickly check calendar events for the next 2 days",
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
        description: "Run a shell command on the host machine",
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
    argsStr: string
): Promise<string> {
    let args: any;
    try {
        args = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
    } catch {
        args = {};
    }

    console.log(`Handling function call: ${functionName}`, args);

    switch (functionName) {
        case "ask_clod_quick":
            return bridge.askClodQuick(args.message);
        case "ask_clod_full":
            return bridge.askClodFull(args.message);
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
