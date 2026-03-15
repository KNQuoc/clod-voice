import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { OpenClawBridge, openClawFunctions, handleFunctionCall } from './openclaw-bridge';

export class RealtimeClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private apiKey: string;
    private openClawBridge: OpenClawBridge;
    private isConnected = false;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private currentCallId: string | null = null;
    private _audioStarted = false;
    private _responseInProgress = false;
    private _asyncQueue: string[] = [];
    private _useLuxTTS: boolean;
    private _textBuffer: string = '';
    private _directToClod: boolean;

    constructor(apiKey: string, openClawBridge: OpenClawBridge, useLuxTTS: boolean = false, directToClod: boolean = false) {
        super();
        this.apiKey = apiKey;
        this.openClawBridge = openClawBridge;
        this._useLuxTTS = useLuxTTS;
        this._directToClod = directToClod;
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'OpenAI-Beta': 'realtime=v1'
                    }
                });

                this.ws.on('open', () => {
                    console.log('Connected to OpenAI Realtime API');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.setupSession();
                    resolve();
                });

                this.ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleMessage(message);
                    } catch (error) {
                        console.error('Error parsing message:', error);
                    }
                });

                this.ws.on('close', (code, reason) => {
                    console.log(`Disconnected from OpenAI Realtime API (code: ${code}, reason: ${reason?.toString() || 'none'})`);
                    const wasConnected = this.isConnected;
                    this.isConnected = false;
                    // Only reconnect if we were actively connected (not manually disconnected)
                    if (wasConnected && code !== 1000) {
                        this.attemptReconnect();
                    }
                });

                this.ws.on('error', (error) => {
                    console.error('WebSocket error:', error.message || error);
                    if (!this.isConnected) {
                        reject(error);
                    }
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    private setupSession(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const sessionConfig = this._directToClod
            ? {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    voice: 'alloy',
                    instructions: 'You are a speech-to-text relay. Just echo back exactly what the user said. Do not add anything.',
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 800
                    },
                    input_audio_transcription: {
                        model: 'whisper-1',
                        language: 'en'
                    },
                    tools: []
                }
            }
            : {
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    voice: 'alloy',
                    instructions: `You are the voice interface for Clod, Kien's AI assistant. For simple questions, answer directly. For tool tasks, you have two modes:

QUICK tools (fast, use these first): check_email, check_calendar, search_web, run_command, ask_clod_quick.
FULL mode (slower but powerful): ask_clod_full — sends to the real Clod with full memory, project context, and workspace access. Use when the user says "ask Clod", references past conversations, projects, or needs deep context.

IMPORTANT: When you get a response back from ask_clod_full or ask_clod_quick, READ THE RESPONSE ALOUD to the user naturally. Don't just say "Clod said..." — speak the actual content as if you're relaying the answer. Summarize if it's very long, but keep the key information. The user is listening, not reading.

Be conversational and concise. Always respond in English.`,
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 800
                    },
                    input_audio_transcription: {
                        model: 'whisper-1',
                        language: 'en'
                    },
                    tools: openClawFunctions
                }
            };

        this.ws.send(JSON.stringify(sessionConfig));
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'session.created':
                console.log('Session created successfully');
                this.emit('session_created', message.session);
                break;

            case 'session.updated':
                console.log('Session updated successfully');
                break;

            case 'input_audio_buffer.speech_started':
                console.log('User started speaking');
                this.emit('speech_started');
                break;

            case 'input_audio_buffer.speech_stopped':
                console.log('User stopped speaking (Realtime API VAD)');
                this.emit('speech_stopped');
                break;

            case 'conversation.item.input_audio_transcription.completed':
                console.log('Transcription:', message.transcript);
                this.emit('transcription', message.transcript);
                
                // In direct-to-Clod mode: route transcription to OpenClaw
                if (this._directToClod && message.transcript?.trim()) {
                    this.routeToClod(message.transcript.trim());
                }
                break;

            case 'response.audio.delta':
                // Forward audio data to Discord voice (only in non-LuxTTS mode)
                if (!this._useLuxTTS) {
                    if (!this._audioStarted) {
                        console.log('Receiving audio response from Realtime API...');
                        this._audioStarted = true;
                    }
                    this.emit('audio_delta', message.delta);
                }
                break;

            case 'response.audio.done':
                if (!this._useLuxTTS) {
                    console.log('Audio response completed');
                    this._audioStarted = false;
                    this.emit('audio_done');
                }
                break;

            case 'response.text.delta':
                // Buffer text deltas for LuxTTS mode
                if (this._useLuxTTS && message.delta) {
                    this._textBuffer += message.delta;
                }
                break;

            case 'response.text.done':
                // Full text response ready — send to LuxTTS
                if (this._useLuxTTS) {
                    const fullText = message.text || this._textBuffer;
                    this._textBuffer = '';
                    if (fullText) {
                        console.log(`[LuxTTS mode] Text response: "${fullText.substring(0, 100)}..."`);
                        this.emit('text_response', fullText);
                    }
                }
                break;

            case 'response.audio_transcript.delta':
                // In audio mode, text comes via audio_transcript events
                // In direct-to-Clod mode, ignore these (Clod's response is the one we want)
                if (this._useLuxTTS && !this._directToClod && message.delta) {
                    this._textBuffer += message.delta;
                }
                break;

            case 'response.audio_transcript.done':
                if (this._useLuxTTS && !this._directToClod) {
                    const transcriptText = message.transcript || this._textBuffer;
                    this._textBuffer = '';
                    if (transcriptText) {
                        console.log(`[LuxTTS mode] Audio transcript: "${transcriptText.substring(0, 100)}..."`);
                        this.emit('text_response', transcriptText);
                    }
                } else if (this._directToClod) {
                    // Log but don't synthesize — Clod's response handles this
                    console.log(`[Direct-to-Clod] Ignoring Realtime API response: "${(message.transcript || '').substring(0, 50)}"`);
                    this._textBuffer = '';
                }
                break;

            case 'response.created':
                console.log('Response started generating');
                this._responseInProgress = true;
                this._textBuffer = '';
                break;

            case 'response.done':
                console.log('Response fully done');
                // If we have buffered text that wasn't flushed (e.g. no audio_transcript.done fired)
                if (this._useLuxTTS && !this._directToClod && this._textBuffer.length > 0) {
                    console.log(`[LuxTTS mode] Flushing buffered text: "${this._textBuffer.substring(0, 100)}..."`);
                    this.emit('text_response', this._textBuffer);
                    this._textBuffer = '';
                } else {
                    this._textBuffer = '';
                }
                this._responseInProgress = false;
                this.flushAsyncQueue();
                break;

            case 'response.function_call_arguments.done':
                await this.handleFunctionCall(message);
                break;

            case 'error':
                console.error('Realtime API error:', message.error);
                this.emit('error', message.error);
                break;

            default:
                // Log ALL event types for debugging
                if (message.type) {
                    if (message.type.startsWith('response.audio.delta')) {
                        // too noisy, skip
                    } else if (message.type.startsWith('response.audio_transcript')) {
                        console.log(`Event: ${message.type} delta="${(message.delta || message.transcript || '').substring(0, 50)}"`);
                    } else {
                        console.log('Event:', message.type);
                    }
                }
                // Still capture audio_transcript.delta in default handler in case it falls through
                if (message.type === 'response.audio_transcript.delta' && this._useLuxTTS && message.delta) {
                    this._textBuffer += message.delta;
                }
                if (message.type === 'response.audio_transcript.done' && this._useLuxTTS) {
                    const transcriptText = message.transcript || this._textBuffer;
                    this._textBuffer = '';
                    if (transcriptText) {
                        console.log(`[LuxTTS mode] Audio transcript (default): "${transcriptText.substring(0, 100)}..."`);
                        this.emit('text_response', transcriptText);
                    }
                }
                break;
        }
    }

    private async handleFunctionCall(message: any): Promise<void> {
        try {
            const { call_id, name, arguments: args } = message;
            console.log(`Function call: ${name} with args:`, args);

            const result = await handleFunctionCall(this.openClawBridge, name, args);

            // Send function result back to the API
            const functionOutput = {
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: call_id,
                    output: result
                }
            };

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(functionOutput));

                // Trigger a new response
                const responseCreate = {
                    type: 'response.create'
                };
                this.ws.send(JSON.stringify(responseCreate));
            }

        } catch (error) {
            console.error('Error handling function call:', error);
        }
    }

    /**
     * Inject an async response into the conversation.
     * If a response is currently in progress, queues it until idle.
     */
    injectAsyncResponse(text: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot inject async response: WebSocket not connected');
            return;
        }

        if (this._responseInProgress) {
            console.log(`Response in progress, queuing async response (${text.length} chars)`);
            this._asyncQueue.push(text);
            return;
        }

        this.sendAsyncResponse(text);
    }

    /**
     * Actually send an async response to the Realtime API.
     * In LuxTTS mode, we can directly synthesize without going through the Realtime API.
     */
    private sendAsyncResponse(text: string): void {
        if (this._useLuxTTS) {
            // In LuxTTS mode, speak directly — no need to round-trip through the API
            console.log(`[LuxTTS] Async response direct synthesis (${text.length} chars)`);
            this.emit('text_response', text);
            return;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        console.log(`Injecting async response (${text.length} chars)`);

        const injectItem = {
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: `[Clod just responded to your earlier question. Read this aloud naturally:]\n\n${text}`
                }]
            }
        };

        this.ws.send(JSON.stringify(injectItem));

        const responseCreate = {
            type: 'response.create'
        };
        this.ws.send(JSON.stringify(responseCreate));
    }

    /**
     * Flush queued async responses one at a time.
     * Called when a response finishes (response.done).
     */
    private flushAsyncQueue(): void {
        if (this._asyncQueue.length === 0) return;

        const next = this._asyncQueue.shift()!;
        console.log(`Flushing queued async response (${this._asyncQueue.length} remaining)`);
        // Small delay to let the API settle between responses
        setTimeout(() => this.sendAsyncResponse(next), 500);
    }

    /**
     * Route transcription directly to Clod via OpenClaw, bypassing the Realtime API LLM.
     * Response is emitted as 'text_response' for LuxTTS synthesis.
     */
    private _conversationHistory: Array<{ role: string; content: string }> = [];

    private async routeToClod(transcript: string): Promise<void> {
        try {
            console.log(`[Direct-to-Clod] Sending: "${transcript}"`);
            
            // Cancel the Realtime API's auto-response since we don't need it
            if (this._responseInProgress && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'response.cancel' }));
            }

            // Add to conversation history
            this._conversationHistory.push({ role: 'user', content: transcript });
            
            // Keep last 20 messages to avoid token overflow
            if (this._conversationHistory.length > 20) {
                this._conversationHistory = this._conversationHistory.slice(-20);
            }

            const response = await this.openClawBridge.askClodWithHistory(this._conversationHistory);
            console.log(`[Direct-to-Clod] Response (${response.length} chars): "${response.substring(0, 100)}..."`);
            
            // Add assistant response to history
            this._conversationHistory.push({ role: 'assistant', content: response });
            
            this.emit('text_response', response);
        } catch (error) {
            console.error('[Direct-to-Clod] Error:', error);
            this.emit('text_response', "Sorry, I couldn't reach Clod right now.");
        }
    }

    sendAudio(audioData: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Cannot send audio: WebSocket not connected');
            return;
        }

        const audioEvent = {
            type: 'input_audio_buffer.append',
            audio: audioData
        };

        this.ws.send(JSON.stringify(audioEvent));
    }

    clearAudioBuffer(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const clearEvent = {
            type: 'input_audio_buffer.clear'
        };

        this.ws.send(JSON.stringify(clearEvent));
    }

    resetConversation(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        const clearEvent = {
            type: 'conversation.item.truncate',
            content_index: 0
        };

        this.ws.send(JSON.stringify(clearEvent));
    }

    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms`);

        setTimeout(() => {
            this.connect().catch(error => {
                console.error('Reconnection failed:', error);
            });
        }, delay);
    }

    disconnect(): void {
        if (this.ws) {
            this.isConnected = false;
            this.ws.close();
            this.ws = null;
        }
    }

    isReady(): boolean {
        return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
    }
}