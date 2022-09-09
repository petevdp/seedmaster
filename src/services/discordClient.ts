import { environment } from 'services/environment';
import discord from 'discord.js';

export let discordClient: discord.Client;

export async function setupDiscordClient() {
  const client = new discord.Client({ intents: ['GuildMembers', 'Guilds', 'GuildMessages', 'GuildPresences'] });
  await client.login(environment.DISCORD_BOT_TOKEN);
  discordClient = client;
  return client;
}

