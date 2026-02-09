import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import * as dotenv from 'dotenv';

dotenv.config();

const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join your voice channel and start voice conversation')
        .toJSON(),
    
    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Leave the voice channel')
        .toJSON(),
    
    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset the conversation history')
        .toJSON()
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

async function registerCommands() {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

if (require.main === module) {
    registerCommands();
}

export { registerCommands };