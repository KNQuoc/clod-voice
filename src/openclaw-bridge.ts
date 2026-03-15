import fetch from 'node-fetch';
import { execSync } from 'child_process';

export class OpenClawBridge {
    private gatewayUrl: string;
    private token: string;
    private pendingResponses: Array<{ id: string; resolve: (text: string) => void }> = [];
    public onAsyncResponse: ((text: string) => void) | null = null;

    constructor(gatewayUrl: string, token: string) {
        this.gatewayUrl = gatewayUrl;
        this.token = token;
    }

    /**
     * Conversation mode: Send full chat history to Clod for context-aware responses.
     */
    async askClodWithHistory(messages: Array<{ role: string; content: string }>): Promise<string> {
        try {
            const formattedMessages = [
                {
                    role: 'system',
                    content: '[Voice request from Kien via Discord voice chat. Respond concisely in 2-3 sentences max — this will be read aloud via TTS. Be conversational. You have full access to tools, memory, and workspace.]'
                },
                ...messages
            ];

            const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'openclaw:main',
                    messages: formattedMessages
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
            return 'No response from OpenClaw.';
        } catch (error) {
            console.error('Error communicating with OpenClaw (history):', error);
            return `Sorry, I couldn't reach Clod right now: ${error instanceof Error ? error.message : String(error)}`;
        }
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
     * Full mode: Fire-and-forget request to Clod.
     * Returns immediately with an acknowledgment so the voice bot stays responsive.
     * When Clod's response arrives, it's delivered via onAsyncResponse callback.
     */
    async askClodFull(message: string): Promise<string> {
        // Fire the request in the background
        this.fetchClodResponse(message).catch(error => {
            console.error('Background Clod request failed:', error);
            if (this.onAsyncResponse) {
                this.onAsyncResponse(`Sorry, I couldn't reach Clod: ${error instanceof Error ? error.message : String(error)}`);
            }
        });

        // Return immediately so the Realtime API stays responsive
        return "Got it, I'm asking Clod now. Keep talking — I'll let you know when he responds.";
    }

    /**
     * Background fetch using the chat completions endpoint.
     * This creates an isolated completion (not tied to main session),
     * so it won't conflict with ongoing conversations.
     */
    private async fetchClodResponse(message: string): Promise<void> {
        try {
            console.log('[askClodFull] Sending request via chat completions...');
            
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
                            content: `[Voice request from Kien — respond concisely in 2-3 sentences max, this will be read aloud via TTS. You have access to all tools including Canvas LMS, email, calendar, web search, etc.] ${message}`
                        }
                    ]
                })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`OpenClaw API error: ${response.status} - ${text}`);
            }

            const data = await response.json() as any;
            console.log('[askClodFull] Response received');

            // Chat completions returns standard OpenAI format
            let reply: string | null = null;
            
            if (data.choices?.[0]?.message?.content) {
                reply = data.choices[0].message.content;
            } else {
                console.log('[askClodFull] Unexpected shape:', JSON.stringify(data).substring(0, 500));
                reply = JSON.stringify(data);
            }

            const finalReply = reply || 'Clod responded but the reply was empty.';
            console.log(`[askClodFull] Clod responded (${finalReply.length} chars), delivering to voice...`);

            // Deliver via callback → gets injected into Realtime API conversation
            if (this.onAsyncResponse) {
                this.onAsyncResponse(finalReply);
            } else {
                console.warn('No async response handler set — Clod reply dropped');
            }
        } catch (error) {
            throw error;
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
        description: "Full mode: Send a request to the REAL Clod with full context — memory, workspace, project knowledge, personal preferences. Use this for complex tasks, anything referencing past conversations, projects (like blockd4), personal context, or when the user explicitly says 'ask Clod' or needs the real assistant. Slower but much more capable. The response comes back as text — READ IT ALOUD to the user.",
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
