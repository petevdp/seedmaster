import { environment } from './globalServices/environment';
import discord from 'discord.js'
import { Future } from './lib/future';

let _discordClientDeferred = new Future<discord.Client>();
export const discordClientDeferred = _discordClientDeferred as Promise<discord.Client>

export async function logInToDiscord() {
  const client = new discord.Client({ intents: ['GuildMembers', 'Guilds', 'GuildMessages', 'GuildPresences'] });
  await client.login(environment.DISCORD_BOT_TOKEN);
  _discordClientDeferred.resolve(client);
  return client;
}

