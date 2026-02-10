import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnection,
    VoiceConnectionStatus,
    AudioPlayer,
    AudioReceiveStream,
    EndBehaviorType,
    StreamType
} from '@discordjs/voice';
import { VoiceBasedChannel, GuildMember } from 'discord.js';
import * as prism from 'prism-media';
import { Readable } from 'stream';
import { RealtimeClient } from './realtime-client';

export class VoiceHandler {
    private connection: VoiceConnection | null = null;
    private audioPlayer: AudioPlayer;
    private realtimeClient: RealtimeClient;
    private isListening = false;
    private isPlaying = false;
    private responseAudioChunks: Buffer[] = [];
    private activeStreams: Map<string, boolean> = new Map();

    constructor(realtimeClient: RealtimeClient) {
        this.realtimeClient = realtimeClient;
        this.audioPlayer = createAudioPlayer();
        this.setupAudioPlayer();
        this.setupRealtimeClient();
    }

    private setupAudioPlayer(): void {
        this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
            console.log('Audio player started playing');
        });

        this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
            console.log('Audio player finished playing');
        });

        this.audioPlayer.on('error', (error) => {
            console.error('Audio player error:', error);
        });
    }

    private setupRealtimeClient(): void {
        this.realtimeClient.on('audio_delta', (audioData: string) => {
            // Buffer audio chunks until response is complete
            const pcmChunk = Buffer.from(audioData, 'base64');
            this.responseAudioChunks.push(pcmChunk);
        });

        this.realtimeClient.on('audio_done', () => {
            // Play the complete response
            this.playCompleteResponse();
        });

        this.realtimeClient.on('speech_started', () => {
            console.log('Speech detected, stopping audio output');
            this.stopPlayback();
        });
    }

    async joinChannel(channel: VoiceBasedChannel, member: GuildMember): Promise<void> {
        if (!channel.guild.members.me?.permissions.has('Connect')) {
            throw new Error('Missing permissions to connect to voice channel');
        }

        if (!channel.guild.members.me?.permissions.has('Speak')) {
            throw new Error('Missing permissions to speak in voice channel');
        }

        this.connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator as any,
            selfDeaf: false,
            selfMute: false,
            daveEncryption: false
        } as any);

        this.connection.on(VoiceConnectionStatus.Ready, () => {
            console.log('Voice connection ready');
            this.startListening();
        });

        this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
            console.log('Voice connection disconnected');
            this.stopListening();
        });

        this.connection.on('error', (error) => {
            console.error('Voice connection error:', error);
        });

        this.connection.subscribe(this.audioPlayer);
    }

    private startListening(): void {
        if (!this.connection || this.isListening) return;

        console.log('Starting to listen for audio');
        this.isListening = true;

        const receiver = this.connection.receiver;

        receiver.speaking.on('start', (userId) => {
            // Skip if we're already processing audio from this user
            if (this.activeStreams.get(userId)) return;
            
            console.log(`User ${userId} started speaking`);
            this.activeStreams.set(userId, true);
            
            const audioStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 300
                }
            });

            this.processUserAudio(audioStream, userId);
        });
    }

    private processUserAudio(audioStream: AudioReceiveStream, userId?: string): void {
        let chunkCount = 0;

        // Discord sends opus packets. Decode to PCM 48kHz mono.
        const opusDecoder = new prism.opus.Decoder({
            frameSize: 960,
            channels: 1,
            rate: 48000
        });

        opusDecoder.on('error', (error: Error) => {
            // Corrupt frames happen when streams overlap or get interrupted
            // Just skip them — the Realtime API handles gaps fine
            if (!error.message.includes('corrupted')) {
                console.error('Opus decoder error:', error.message);
            }
        });

        audioStream.on('error', (error: Error) => {
            console.error('Audio stream error:', error.message);
        });

        // Pipe opus stream through decoder, then manually downsample
        const decoded = audioStream.pipe(opusDecoder);

        decoded.on('data', (chunk: Buffer) => {
            chunkCount++;
            // Input: 48kHz mono s16le (2 bytes per sample)
            // Output: 24kHz mono s16le — skip every other sample
            const downsampled = Buffer.alloc(chunk.length / 2);
            for (let i = 0, j = 0; i < chunk.length; i += 4, j += 2) {
                downsampled[j] = chunk[i];
                downsampled[j + 1] = chunk[i + 1];
            }
            if (chunkCount === 1) {
                console.log(`Sending audio to Realtime API (raw: ${chunk.length}, downsampled: ${downsampled.length})`);
            }
            const base64Audio = downsampled.toString('base64');
            this.realtimeClient.sendAudio(base64Audio);
        });

        decoded.on('end', () => {
            if (userId) this.activeStreams.delete(userId);
            console.log(`User finished speaking (sent ${chunkCount} audio chunks)`);
        });

        decoded.on('error', (error: Error) => {
            if (!error.message.includes('corrupted')) {
                console.error('Decoded stream error:', error.message);
            }
        });
    }

    private playCompleteResponse(): void {
        if (this.responseAudioChunks.length === 0) return;

        try {
            // Combine all PCM chunks (24kHz 16-bit mono)
            const fullPcm = Buffer.concat(this.responseAudioChunks);
            this.responseAudioChunks = [];
            console.log(`Playing response: ${fullPcm.length} bytes of PCM audio`);

            // Upsample from 24kHz mono to 48kHz stereo
            const upsampled = Buffer.alloc(fullPcm.length * 4);
            for (let i = 0; i < fullPcm.length; i += 2) {
                const lo = fullPcm[i];
                const hi = fullPcm[i + 1];
                const outIdx = i * 4;
                upsampled[outIdx] = lo;
                upsampled[outIdx + 1] = hi;
                upsampled[outIdx + 2] = lo;
                upsampled[outIdx + 3] = hi;
                upsampled[outIdx + 4] = lo;
                upsampled[outIdx + 5] = hi;
                upsampled[outIdx + 6] = lo;
                upsampled[outIdx + 7] = hi;
            }

            // Create a readable stream from the complete buffer
            const pcmStream = new Readable({
                read() {
                    this.push(upsampled);
                    this.push(null);
                }
            });

            // Encode to opus
            const opusEncoder = new prism.opus.Encoder({
                frameSize: 960,
                channels: 2,
                rate: 48000
            });

            const resource = createAudioResource(pcmStream.pipe(opusEncoder), {
                inputType: StreamType.Opus,
            });

            this.audioPlayer.play(resource);
            this.isPlaying = true;
            console.log('Audio playback started');
        } catch (error) {
            console.error('Error playing complete response:', error);
        }
    }

    leaveChannel(): void {
        this.stopListening();
        
        if (this.connection) {
            this.connection.destroy();
            this.connection = null;
        }

        this.stopPlayback();

        if (this.audioPlayer) {
            this.audioPlayer.stop();
        }
    }

    private stopPlayback(): void {
        this.responseAudioChunks = [];
        this.audioPlayer.stop();
        this.isPlaying = false;
    }

    private stopListening(): void {
        this.isListening = false;
        console.log('Stopped listening for audio');
    }

    resetConversation(): void {
        this.realtimeClient.resetConversation();
        this.stopPlayback();
        console.log('Conversation reset');
    }

    isConnected(): boolean {
        return this.connection?.state.status === VoiceConnectionStatus.Ready;
    }
}