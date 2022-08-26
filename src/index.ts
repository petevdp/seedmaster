import { ConnectionPool } from '@databases/pg';
import { REST } from '@discordjs/rest';
import discord, {
  Routes,
  SlashCommandBuilder,
  TextChannel
} from 'discord.js';
import { EMPTY, Observable } from 'rxjs';
import { Server, Tenant } from './__generated__';
import { config } from './config';
import { getConfiguredConnectionPool, server, tenant } from './db';
import { Environment, retrieveEnvironment } from './environment';
import { SeederResponse } from './models';
import { ServerManager } from './ServerManager';

let db: ConnectionPool;

let environment: Environment;
let client: discord.Client<boolean>;
const seederResponses: Map<string, SeederResponse> = new Map();
let guildId: string;
let instanceTenant: Tenant;


// a specific thrown error that occurs during a discord interaction that we want to notify the user about
class InteractionError extends Error {
  constructor(msg: string, interaction: discord.ChatInputCommandInteraction<discord.CacheType>) {
    super(msg);
    interaction.reply({ ephemeral: true, content: msg });
  }
}

async function retrieveConfig() {
  return;
}


// async function manageAddServerInteraction(interaction: discord.ChatInputCommandInteraction<discord.CacheType>, instanceTenant: Tenant): Promise<Server> {
//   const uuid = uuidv4();
//
//   const modal = new ModalBuilder()
//     .setCustomId(`${uuid}-configurationModal`)
//     .setTitle('Configure Seeding');
//
//
//   const channelInputId = `${uuid}-channelInput`;
//   const channelInput = new TextInputBuilder()
//     .setCustomId(channelInputId)
//     .setLabel('channel name')
//     .setRequired(true)
//     .setStyle(TextInputStyle.Short);
//
//   const serverHostInputId = `${uuid}-serverHostInput`;
//   const serverHostInput = new TextInputBuilder()
//     .setCustomId(serverHostInputId)
//     .setLabel('server host')
//     .setRequired(true)
//     .setStyle(TextInputStyle.Short);
//
//   const queryPortInputId = `${uuid}-queryPortInput`;
//   const queryPortInput = new TextInputBuilder()
//     .setCustomId(queryPortInputId)
//     .setLabel('Query Port')
//     .setRequired(true)
//     .setStyle(TextInputStyle.Short);
//
//   const seedThresholdInputId = `${uuid}-seedThreshold`;
//   const seedThresholdInput = new TextInputBuilder()
//     .setCustomId(seedThresholdInputId)
//     .setLabel('Seed Threshold')
//     .setRequired(true)
//     .setStyle(TextInputStyle.Short);
//
//   modal.addComponents(
//     new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(channelInput),
//     new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(serverHostInput),
//     new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(queryPortInput),
//     new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(seedThresholdInput)
//   );
//
//   interaction.showModal(modal);
//   const submission = await interaction.awaitModalSubmit({ time: hoursToMilliseconds(1) });
//
//   const tenant_id = instanceTenant.id;
//
//   let seed_channel_id: string;
//   {
//     // find channel id for posted name
//     let channelName = submission.fields.getTextInputValue(channelInputId).trim().toLowerCase();
//     const fetchedGuild = await fetchTenantGuild();
//     const channel = fetchedGuild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase());
//     if (!channel) {
//       throw new InteractionError(`channel with name "${channelName.trim()}" not exist`, interaction);
//     }
//     if (channel.type !== discord.ChannelType.GuildText) {
//       throw new InteractionError('given channel is not a text channel!', interaction);
//     }
//     seed_channel_id = channel.id;
//   }
//
//   let host = submission.fields.getTextInputValue(serverHostInputId).trim();
//   if (!isValidHostname(host)) {
//     throw new InteractionError('invalid hostname', interaction);
//   }
//   const query_port = parseInt(submission.fields.getTextInputValue(queryPortInputId).trim());
//   if (query_port === NaN) {
//     throw new InteractionError('invalid query port', interaction);
//   }
//
//   const seed_threshold: number = parseInt(submission.fields.getTextInputValue(seedThresholdInputId).trim());
//   if (seed_threshold === NaN) {
//     throw new InteractionError('invalid seed threshold', interaction);
//   }
//
//   const [seedServer] = await server(db).insert({
//     tenant_id: instanceTenant.id,
//     host,
//     query_port,
//     seed_threshold,
//     seed_channel_id
//   });
//   if (!seedServer) {
//     throw new InteractionError('Something went wrong when writing the new server to the database.', interaction);
//   }
//   await submission.reply({
//     ephemeral: true,
//     content: 'Successfully added new server!'
//   });
//   return seedServer;
// }


function extractEmbedFromSeedMessage(channel: TextChannel, serverId: number) {
  for (let msg of channel.messages.cache.values()) {
    for (let embed of msg.embeds) {
    }
  }
}


function getSeedEmbedTitle(server: Server, displayedName: string) {
  return displayedName + ` - (${server.id})`;
}


async function main() {
  // load environment
  console.log('running main');

  environment = retrieveEnvironment();

  client = new discord.Client({ intents: ['GuildMembers', 'Guilds', 'GuildMessages'] });

  {
    // configure db connection
    db = getConfiguredConnectionPool();
  }
  {
    // get tenant info
    const tenants = await tenant(db).select({}).all();
    if (tenants.length > 1) {
      throw new Error('More than one tenant Found');
    } else if (tenants.length === 0) {
      throw new Error('no instance tenant found');
    }
    instanceTenant = tenants[0];
  }

  await client.login(environment.DISCORD_BOT_TOKEN);
  const guilds = await client.guilds.fetch();
  const tenantGuild = [...guilds][0][1];
  let guild = await tenantGuild.fetch();


  {
    // register application commands

    const commands = [
      new SlashCommandBuilder().setName('sm-configure-server').setDescription('reconfigure an existing server')
        .addSubcommand((cmd) => cmd.setName('add').setDescription('Configure a new server'))
    ];
    const rest = new REST({ version: '10' }).setToken(environment.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(environment.DISCORD_CLIENT_ID, guild.id), { body: commands });
    console.log('successfully registered application commands');
  }


  // handle commands
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;


    // if (interaction.commandName === 'sm-configure-server' && interaction.options.getSubcommand(true) === 'add') {
    //   const setupServer = await manageAddServerInteraction(interaction, instanceTenant);
    //   await ensureSeedChannelSetup(setupServer!);
    // }
  });


  {
    const serversInDb = await server(db).select({ tenant_id: instanceTenant.id }).all();
    let ops: Promise<any>[] = [];
    for (let inDb of serversInDb) {
      const configured = config.servers.find((s) => s.host + ':' + s.query_port === inDb.query_port + ':' + s.host);
      if (configured) {
        const update = server(db).update({ id: inDb.id }, configured);
        ops.push(update);
      } else {
        ops.push(server(db).delete({ id: inDb.id }));
      }
    }

    for (let configured of config.servers) {
      const inDb = serversInDb.find(s => s.id === configured.id);
      if (!inDb) {
        ops.push(server(db).insert({
          ...configured,
          tenant_id: instanceTenant.id
        }));
      }
    }
    console.log(config);

    console.log('test');
    await Promise.all(ops);
    const allServers = await server(db).select({}).all();
    console.table(allServers);
    await Promise.all(allServers.map(async (s) => {

      const manager = new ServerManager(s,client,instanceTenant, db);
      await manager.setup();
    }));

    allServers;
  }
}


main();
