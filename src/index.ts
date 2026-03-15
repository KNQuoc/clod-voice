import { Client, GatewayIntentBits, VoiceBasedChannel, ChatInputCommandInteraction } from 'discord.js';
import { VoiceHandler } from './voice-handler';
import { RealtimeClient } from './realtime-client';
import { OpenClawBridge } from './openclaw-bridge';
import { LuxTTSClient } from './luxtts-client';
import { registerCommands } from './register-commands';
import * as dotenv from 'dotenv';

dotenv.config();

class DiscordVoiceBot {
    private client: Client;
    private realtimeClient: RealtimeClient;
    private openClawBridge: OpenClawBridge;
    private voiceHandler: VoiceHandler;
    private luxtts: LuxTTSClient | null = null;

    constructor() {
        // Initialize Discord client with necessary intents
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMessages
            ]
        });

        // Initialize OpenClaw bridge
        this.openClawBridge = new OpenClawBridge(
            process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789',
            process.env.OPENCLAW_GATEWAY_TOKEN!
        );

        // Initialize LuxTTS if enabled
        const useLuxTTS = process.env.USE_LUXTTS !== 'false'; // default: on
        if (useLuxTTS) {
            const luxttsUrl = process.env.LUXTTS_URL || 'http://localhost:8099';
            this.luxtts = new LuxTTSClient(luxttsUrl);
            console.log(`LuxTTS enabled: ${luxttsUrl}`);
        }

        // Initialize Realtime client
        // directToClod: use OpenAI only for STT, route all responses through Clod
        const directToClod = useLuxTTS; // when LuxTTS is on, go direct to Clod
        this.realtimeClient = new RealtimeClient(
            process.env.OPENAI_API_KEY!,
            this.openClawBridge,
            useLuxTTS,
            directToClod
        );

        // Initialize voice handler
        this.voiceHandler = new VoiceHandler(
            this.realtimeClient,
            this.luxtts || undefined
        );

        // Wire up async response delivery: when Clod responds in the background,
        // inject it into the Realtime API conversation to be spoken aloud
        this.openClawBridge.onAsyncResponse = (text: string) => {
            console.log('Async response from Clod, injecting into voice...');
            this.realtimeClient.injectAsyncResponse(text);
        };

        this.setupEventHandlers();
    }

    private setupEventHandlers(): void {
        this.client.once('ready', async () => {
            console.log(`Logged in as ${this.client.user?.tag}!`);
            console.log('Bot is ready! Use /join in a voice channel to start.');
        });

        this.client.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            await this.handleSlashCommand(interaction);
        });

        this.client.on('voiceStateUpdate', (oldState, newState) => {
            // Handle voice state changes if needed
            const botId = this.client.user?.id;
            if (!botId) return;

            // If the bot was disconnected from voice channel
            if (oldState.member?.id === botId && oldState.channelId && !newState.channelId) {
                console.log('Bot was disconnected from voice channel');
                this.voiceHandler.leaveChannel();
                this.realtimeClient.disconnect();
            }
        });

        this.client.on('error', (error) => {
            console.error('Discord client error:', error);
        });

        // Handle Realtime client events
        this.realtimeClient.on('error', (error) => {
            console.error('Realtime client error:', error);
        });

        this.realtimeClient.on('transcription', (transcript) => {
            console.log('User said:', transcript);
        });
    }

    private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            switch (interaction.commandName) {
                case 'join':
                    await this.handleJoinCommand(interaction);
                    break;
                case 'leave':
                    await this.handleLeaveCommand(interaction);
                    break;
                case 'reset':
                    await this.handleResetCommand(interaction);
                    break;
                default:
                    await interaction.reply({ 
                        content: 'Unknown command!', 
                        ephemeral: true 
                    });
            }
        } catch (error) {
            console.error('Error handling slash command:', error);
            
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: 'An error occurred while processing your command.', 
                    ephemeral: true 
                });
            }
        }
    }

    private async handleJoinCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        // Check if user is in a voice channel
        const member = interaction.member as any;
        const voiceChannel = member?.voice?.channel as VoiceBasedChannel;

        if (!voiceChannel) {
            await interaction.reply({ 
                content: 'You need to be in a voice channel first!', 
                ephemeral: true 
            });
            return;
        }

        // Check if bot is already connected
        if (this.voiceHandler.isConnected()) {
            await interaction.reply({ 
                content: 'I\'m already connected to a voice channel!', 
                ephemeral: true 
            });
            return;
        }

        try {
            // Defer reply since connecting might take a moment
            await interaction.deferReply({ ephemeral: true });

            // Connect to Realtime API if not already connected
            if (!this.realtimeClient.isReady()) {
                console.log('Connecting to OpenAI Realtime API...');
                await this.realtimeClient.connect();
                console.log('Connected to OpenAI Realtime API');
            }

            await this.voiceHandler.joinChannel(voiceChannel, member);
            await interaction.editReply({ 
                content: `Joined ${voiceChannel.name}! Start speaking and I'll respond with voice. Use \`/reset\` to clear conversation history.`,
            });
        } catch (error) {
            console.error('Error joining voice channel:', error);
            const msg = 'Failed to join voice channel. Please check my permissions and try again.';
            if (interaction.deferred) {
                await interaction.editReply({ content: msg });
            } else {
                await interaction.reply({ content: msg, ephemeral: true });
            }
        }
    }

    private async handleLeaveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        if (!this.voiceHandler.isConnected()) {
            await interaction.reply({ 
                content: 'I\'m not connected to any voice channel!', 
                ephemeral: true 
            });
            return;
        }

        this.voiceHandler.leaveChannel();
        this.realtimeClient.disconnect();
        await interaction.reply({ 
            content: 'Left the voice channel!', 
            ephemeral: true 
        });
    }

    private async handleResetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        this.voiceHandler.resetConversation();
        await interaction.reply({ 
            content: 'Conversation history has been reset!', 
            ephemeral: true 
        });
    }

    async start(): Promise<void> {
        try {
            await this.client.login(process.env.DISCORD_TOKEN);
        } catch (error) {
            console.error('Failed to login to Discord:', error);
            process.exit(1);
        }
    }

    async stop(): Promise<void> {
        console.log('Shutting down bot...');
        
        this.voiceHandler.leaveChannel();
        this.realtimeClient.disconnect();
        
        await this.client.destroy();
        console.log('Bot shutdown complete');
    }
}

// Create and start the bot
const bot = new DiscordVoiceBot();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await bot.stop();
    process.exit(0);
});

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

// Start the bot
bot.start().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
});

export { DiscordVoiceBot };