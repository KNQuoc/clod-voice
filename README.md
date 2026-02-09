# Discord Voice Claude Bot

A Discord voice bot that uses OpenAI's Realtime API for natural voice conversations, with seamless integration to OpenClaw/Claude for tool-heavy requests like email, calendar, web search, and file operations.

## Features

- **Voice-to-Voice Conversations**: Direct voice interaction using OpenAI's Realtime API (~1s latency)
- **Tool Integration**: Complex requests automatically routed to OpenClaw/Claude for tool access
- **Natural Audio Processing**: Handles Discord's Opus audio format and converts to/from OpenAI's PCM format
- **Smart Function Calling**: Routes requests for email, calendar, web search, commands to Claude
- **Conversation Management**: Reset conversation history, join/leave voice channels
- **Robust Error Handling**: Automatic reconnection and graceful error recovery

## Architecture

```
Discord Voice ↔ Voice Handler ↔ OpenAI Realtime API ↔ OpenClaw Bridge ↔ Claude Tools
```

- **OpenAI Realtime API**: Handles direct voice-to-voice for casual conversation
- **OpenClaw Integration**: Routes complex requests requiring tools to Claude
- **Audio Pipeline**: Discord Opus ↔ PCM 16-bit 24kHz mono for OpenAI

## Prerequisites

1. **Node.js** (v18 or higher)
2. **Discord Bot Token** with voice permissions
3. **OpenAI API Key** with Realtime API access
4. **OpenClaw Gateway** running locally at `http://localhost:18789`
5. **FFmpeg** (for audio processing) - install via:
   - Windows: `winget install FFmpeg` or download from https://ffmpeg.org/
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`

## Setup

### 1. Clone and Install Dependencies

```bash
git clone <this-repo>
cd discord-voice-claude
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_id
OPENAI_API_KEY=your_openai_api_key
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your_openclaw_gateway_token
```

### 3. Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Create a new application
3. Go to "Bot" section, create a bot and copy the token
4. Enable these bot permissions:
   - **Scopes**: `bot`, `applications.commands`
   - **Bot Permissions**: `Connect`, `Speak`, `Use Voice Activity`
5. Copy the Application ID for `DISCORD_CLIENT_ID`

### 4. OpenClaw Setup

Make sure OpenClaw gateway is running:

```bash
openclaw gateway start
```

Get your gateway token from OpenClaw configuration.

### 5. Register Discord Commands

```bash
npm run register
```

### 6. Build and Start

```bash
npm run build
npm start
```

Or for development:

```bash
npm run dev
```

## Usage

### Discord Commands

- `/join` - Bot joins your voice channel and starts listening
- `/leave` - Bot leaves the voice channel
- `/reset` - Clears conversation history

### Voice Interaction

1. Use `/join` while in a voice channel
2. Start speaking - the bot will respond with voice for simple questions
3. For complex requests (email, calendar, web search, file operations), the bot automatically routes to Claude via OpenClaw
4. Use `/reset` to clear conversation history if needed

### Example Interactions

**Direct Voice (OpenAI Realtime API):**
- "What's the weather like?"
- "Tell me a joke"
- "How are you doing?"

**Routed to Claude (via OpenClaw):**
- "Check my email for anything urgent"
- "What's on my calendar tomorrow?"
- "Search the web for latest news about AI"
- "Run a command to check disk space"

## Technical Details

### Audio Format Conversion

- **Discord Input**: Opus 48kHz stereo
- **OpenAI Realtime**: PCM 16-bit 24kHz mono (base64)
- **Conversion Pipeline**: Opus → PCM → Resample → Base64

### OpenAI Realtime API Configuration

```json
{
  "modalities": ["text", "audio"],
  "voice": "alloy",
  "turn_detection": { "type": "server_vad" },
  "input_audio_transcription": { "model": "whisper-1" }
}
```

### Function Calling

The bot registers these functions with OpenAI Realtime API:
- `ask_claude(message)` - General Claude requests
- `check_email()` - Check for urgent emails
- `check_calendar()` - Check upcoming events
- `search_web(query)` - Web search
- `run_command(command)` - Execute commands

## Troubleshooting

### Common Issues

**"FFmpeg not found"**
- Install FFmpeg and ensure it's in your PATH

**"Cannot connect to OpenClaw gateway"**
- Make sure OpenClaw gateway is running: `openclaw gateway status`
- Check the gateway URL and token in `.env`

**"Bot not responding to voice"**
- Check Discord permissions (Connect, Speak, Use Voice Activity)
- Verify OpenAI API key has Realtime API access
- Check console logs for WebSocket errors

**"Audio quality issues"**
- Ensure stable internet connection
- Check Discord voice channel region/server location

### Debugging

Enable detailed logging by adding to your `.env`:
```env
DEBUG=discord-voice-claude:*
```

Check logs for:
- WebSocket connection status
- Audio processing pipeline
- Function call routing
- OpenClaw API responses

## Development

### Project Structure

```
src/
├── index.ts              # Main bot entry point
├── voice-handler.ts      # Discord voice connection management
├── realtime-client.ts    # OpenAI Realtime API WebSocket client
├── openclaw-bridge.ts    # Bridge to OpenClaw gateway
└── register-commands.ts  # Discord slash command registration
```

### Building

```bash
npm run build    # Compile TypeScript
npm run dev      # Build and run
```

### Adding New Functions

1. Add function definition to `openClawFunctions` in `openclaw-bridge.ts`
2. Add handler case to `handleFunctionCall`
3. The OpenAI Realtime API will automatically call your function when appropriate

## License

MIT License - see LICENSE file for details

## Support

For issues with:
- **OpenAI Realtime API**: Check OpenAI documentation and API status
- **Discord Integration**: Verify bot permissions and Discord.js version
- **OpenClaw Integration**: Ensure gateway is running and accessible
- **Audio Processing**: Check FFmpeg installation and codec support