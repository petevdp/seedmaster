import path from "path";

export * from './lib/async';
export * from './lib/number';
import discord, {SlashCommandBuilder, Routes} from 'discord.js';
import dotenv from 'dotenv';
import * as fs from "fs";
import tsEnv from "@lpgera/ts-env";
import {REST} from '@discordjs/rest';

interface Seeder {
  discordId: string;
  steamId: string;
  preferences: {
    notificationsEnabled: boolean;
    notifyWhen: 'online' | 'playing' | 'always'
  };
}

interface TenantOptions {
  seedThreshold: number;
}

interface Tenant {
  discordServerId: string
  tenantOptions: TenantOptions;
}

interface Server {
  serverResponseId: string;
  host: string;
  queryPort: number;
  seedThreshold: number;
}

interface SeedAttempt {
  attemptId: string;
  serverId: string;
  // discordId / response
  responses: Map<string, SeederResponse>;
  expectedPlayerCount: number;
  createdAt: Date;
  seederCount: number;
}

interface SeederResponse {
  // seeder discord id
  seederResponseId: string;
  discordId: string;
  attending: boolean;
  createdAt: Date;
}


const servers: Map<string, Server> = new Map();
const seeders: Map<string, Seeder> = new Map();
const seedAttempts: Map<string, SeedAttempt> = new Map();

let tenant: Tenant;


let environment: ReturnType<typeof retrieveEnvironment>;
let client: discord.Client<boolean>;
const seederResponses: Map<string, SeederResponse> = new Map();
let guild: discord.Guild;


function retrieveEnvironment() {
  dotenv.config();
  return {
    DISCORD_BOT_TOKEN: tsEnv.stringOrThrow('DISCORD_BOT_TOKEN'),
    DISCORD_CLIENT_ID: tsEnv.stringOrThrow('DISCORD_CLIENT_ID'),
  };
}

async function main() {
  // load environment
  console.log('running main');

  environment = retrieveEnvironment();

  client = new discord.Client({intents: ['GuildMembers', 'Guilds', 'GuildMessages']});


  await client.login(environment.DISCORD_BOT_TOKEN);
  const guilds = await client.guilds.fetch();
  const tenantGuild = [...guilds][0][1];
  const guild = await tenantGuild.fetch({});

  tenant = {
    discordServerId: guild.id,
    tenantOptions: {
      seedThreshold: 20
    }
  }

  {
    // register application commands

    const commands = [
      new SlashCommandBuilder().setName('configure').setDescription('set up seedmaster')
    ]
    const rest = new REST({version: '10'}).setToken(environment.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(environment.DISCORD_CLIENT_ID, guild.id), {body: commands})
    console.log('successfully registered application commands')
  }

  // handle commands
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;


    switch (interaction.commandName) {
      case 'configure': {
        break;
      }
    }
  })

  {
    // initialize configuration
    const config = await retrieveOrSetupConfig();


  }

  guilds
}

main();
