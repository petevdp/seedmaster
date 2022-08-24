import { ConnectionPool } from '@databases/pg';
import { REST } from '@discordjs/rest';
import { v4 as uuidv4 } from 'uuid';
import isValidHostname from 'is-valid-hostname';
import hoursToMilliseconds from 'date-fns/hoursToMilliseconds';
import GameDig from 'gamedig';
import discord, {
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  Message,
  ModalActionRowComponentBuilder,
  TextInputComponent,
  TextChannel,
  ButtonBuilder,
  ButtonStyle,
  MessageActionRowComponentBuilder,
  EmbedBuilder,
  ComponentType,
  Embed,
  MessagePayload,
  MessageOptions,
  APIEmbedField
} from 'discord.js';
import { Server, Tenant } from './__generated__';
import { getConfiguredConnectionPool, server, tenant } from './db';
import { Environment, retrieveEnvironment } from './environment';
import { SeederResponse } from './models';

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

async function fetchTenantGuild() {
  const guilds = await client.guilds.fetch();
  const tenantGuild = guilds.find(g => g.id === instanceTenant.guild_id);
  if (!tenantGuild) throw new Error('unable to find tenant guild');
  return await client.guilds.fetch(tenantGuild.id);
}

async function manageAddServerInteraction(interaction: discord.ChatInputCommandInteraction<discord.CacheType>, instanceTenant: Tenant): Promise<Server> {
  const uuid = uuidv4();

  const modal = new ModalBuilder()
    .setCustomId(`${uuid}-configurationModal`)
    .setTitle('Configure Seeding');


  const channelInputId = `${uuid}-channelInput`;
  const channelInput = new TextInputBuilder()
    .setCustomId(channelInputId)
    .setLabel('channel name')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  const serverHostInputId = `${uuid}-serverHostInput`;
  const serverHostInput = new TextInputBuilder()
    .setCustomId(serverHostInputId)
    .setLabel('server host')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  const queryPortInputId = `${uuid}-queryPortInput`;
  const queryPortInput = new TextInputBuilder()
    .setCustomId(queryPortInputId)
    .setLabel('Query Port')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  const seedThresholdInputId = `${uuid}-seedThreshold`;
  const seedThresholdInput = new TextInputBuilder()
    .setCustomId(seedThresholdInputId)
    .setLabel('Seed Threshold')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(channelInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(serverHostInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(queryPortInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(seedThresholdInput)
  );

  interaction.showModal(modal);
  const submission = await interaction.awaitModalSubmit({ time: hoursToMilliseconds(1) });

  const tenant_id = instanceTenant.id;

  let seed_channel_id: string;
  {
    // find channel id for posted name
    let channelName = submission.fields.getTextInputValue(channelInputId).trim().toLowerCase();
    const fetchedGuild = await fetchTenantGuild();
    const channel = fetchedGuild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase());
    if (!channel) {
      throw new InteractionError(`channel with name "${channelName.trim()}" not exist`, interaction);
    }
    if (channel.type !== discord.ChannelType.GuildText) {
      throw new InteractionError('given channel is not a text channel!', interaction);
    }
    seed_channel_id = channel.id;
  }

  let host = submission.fields.getTextInputValue(serverHostInputId).trim();
  if (!isValidHostname(host)) {
    throw new InteractionError('invalid hostname', interaction);
  }
  const query_port = parseInt(submission.fields.getTextInputValue(queryPortInputId).trim());
  if (query_port === NaN) {
    throw new InteractionError('invalid query port', interaction);
  }

  const seed_threshold: number = parseInt(submission.fields.getTextInputValue(seedThresholdInputId).trim());
  if (seed_threshold === NaN) {
    throw new InteractionError('invalid seed threshold', interaction);
  }

  const [seedServer] = await server(db).insert({
    tenant_id: instanceTenant.id,
    host,
    query_port,
    seed_threshold,
    seed_channel_id
  });
  if (!seedServer) {
    throw new InteractionError('Something went wrong when writing the new server to the database.', interaction);
  }
  await submission.reply({
    ephemeral: true,
    content: 'Successfully added new server!'
  });
  return seedServer;
}


function extractEmbedFromSeedMessage(channel: TextChannel, serverId: number) {
  for (let msg of channel.messages.cache.values()) {
    for (let embed of msg.embeds) {
    }
  }
}

async function queryGameServer(server: Server) {
  const res = GameDig.query({
    type: 'squad',
    host: server.host,
    port: server.query_port,
  });
  return res;
}


function getSeedEmbedTitle(server: Server, displayedName: string) {
  return displayedName + ` - (${server.id})`;
}

async function ensureSeedChannelSetup(server: Server) {
  const guild = await fetchTenantGuild();
  const channel = await client.channels.fetch(server.seed_channel_id) as TextChannel;

  const res = await queryGameServer(server);
  await channel.messages.fetch();
  let message: Message | null = null;
  for (let msg of channel.messages.cache.values()) {
    const e = msg.embeds.find(embed => (embed.title as string).includes(`(${server.id})`));
    if (e) {
      message = msg;
      break;
    }
  }

  res.players;

  let players = [{ name: 'grey275' }, { name: 'hihif2' }, { name: 'niloc4' }, { name: 'etc' }];
  players = [...players, ...players, ...players];


  const embedBuilder = new EmbedBuilder()
    .setTitle(`${res.name} (${server.id})`)
    .setFields({name: 'Status: ', value: (`${Math.min(res.players.length, res.maxplayers)} / ${server.seed_threshold} (${res.players.length >= server.seed_threshold ? 'seeding' : 'pending'})`)});

  // const fields:

  const signUpButton = new ButtonBuilder()
    .setCustomId('sign-up')
    .setLabel('Sign Up')
    .setStyle(ButtonStyle.Secondary);

  const builtMessage: MessageOptions = {
    components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(signUpButton)],
    embeds: [embedBuilder]
  };

  if (!message) {
    await channel.send(builtMessage);
  } else {
    await message.edit({
      components: builtMessage.components,
      embeds: builtMessage.embeds,
      content: builtMessage.content
    });
  }

  if (!channel) {
    throw new Error(`seed channel for server ${server.host}:${server.query_port} does not exist`);
  }
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


    if (interaction.commandName === 'sm-configure-server' && interaction.options.getSubcommand(true) === 'add') {
      const setupServer = await manageAddServerInteraction(interaction, instanceTenant);
      await ensureSeedChannelSetup(setupServer!);
    }
  });


  {
    const configuredServers = await server(db).select({tenant_id: instanceTenant.id}).all();
    await Promise.all(configuredServers.map(ensureSeedChannelSetup));
  }


  {
    // initialize configuration
    const config = await retrieveConfig();
  }

  guilds;
}

main();
