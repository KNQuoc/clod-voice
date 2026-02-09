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

    constructor(apiKey: string, openClawBridge: OpenClawBridge) {
        super();
        this.apiKey = apiKey;
        this.openClawBridge = openClawBridge;
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

        const sessionConfig = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                voice: 'alloy',
                instructions: `You are Claude, a helpful AI assistant. For simple questions, answer directly with voice. For tasks requiring tools (email, calendar, web search, file operations, running commands, or anything that needs external integrations), use the appropriate function calls to route requests to Claude via OpenClaw.

Be conversational and natural in your voice responses. Keep responses concise unless asked for details. Always respond in English.`,
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 200
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
                console.log('User stopped speaking');
                this.emit('speech_stopped');
                break;

            case 'conversation.item.input_audio_transcription.completed':
                console.log('Transcription:', message.transcript);
                this.emit('transcription', message.transcript);
                break;

            case 'response.audio.delta':
                // Forward audio data to Discord voice
                if (!this._audioStarted) {
                    console.log('Receiving audio response from Realtime API...');
                    this._audioStarted = true;
                }
                this.emit('audio_delta', message.delta);
                break;

            case 'response.audio.done':
                console.log('Audio response completed');
                this._audioStarted = false;
                this.emit('audio_done');
                break;

            case 'response.created':
                console.log('Response started generating');
                break;

            case 'response.done':
                console.log('Response fully done');
                break;

            case 'response.function_call_arguments.done':
                await this.handleFunctionCall(message);
                break;

            case 'error':
                console.error('Realtime API error:', message.error);
                this.emit('error', message.error);
                break;

            default:
                // Log all event types we're not handling explicitly
                if (message.type && !message.type.startsWith('response.audio.delta')) {
                    console.log('Event:', message.type);
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