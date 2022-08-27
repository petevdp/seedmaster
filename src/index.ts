import { ConnectionPool } from '@databases/pg';
import { REST } from '@discordjs/rest';
import hoursToMilliseconds from 'date-fns/hoursToMilliseconds';
import discord, {
  ActionRowBuilder,
  ButtonInteraction,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  EmbedBuilder,
  Routes,
  SelectMenuBuilder,
  SlashCommandBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  SelectMenuComponentOptionData,
  ButtonBuilder,
  ButtonStyle,
  SelectMenuInteraction,
  Interaction,
  ModalSubmitInteraction
} from 'discord.js';
import {
  ConnectableObservable,
  EMPTY,
  from,
  Observable,
  of,
  Subject,
  throwError
} from 'rxjs';
import {
  catchError,
  share,
  filter,
  concatAll,
  concatMap,
  map,
  mergeMap,
  toArray,
  mergeAll
} from 'rxjs/operators';
import SteamAPI from 'steamapi';
import { Seeder, Server, Tenant } from './__generated__';
import { config } from './config';
import { getConfiguredConnectionPool } from './db';
import * as schema from './db';
import { getInteractionObservable } from './discordUtils';
import { Environment, retrieveEnvironment } from './environment';
import { InteractionError } from './interactionError';
import { Change } from './manageSeeders';
import { SeederResponse } from './models';
import { setupServer } from './SetupServer';
import { v4 as uuidv4 } from 'uuid';
import { queryGameServer } from './squadServer';
import hoursToMinutes from 'date-fns/hoursToMinutes';
import minutesToMilliseconds from 'date-fns/minutesToMilliseconds';

let db: ConnectionPool;

let environment: Environment;
let discordClient: discord.Client<boolean>;
const seederResponses: Map<string, SeederResponse> = new Map();
let guildId: string;
let instanceTenant: Tenant;


async function retrieveConfig() {
  return;
}


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

  discordClient = new discord.Client({ intents: ['GuildMembers', 'Guilds', 'GuildMessages'] });

  {
    // configure db connection
    db = getConfiguredConnectionPool();
  }
  {
    // get tenant info
    [instanceTenant] = await schema.tenant(db)
      .insertOrUpdate(
        ['guild_id'],
        {
          guild_id: BigInt(config.guild_id),
          seed_channel_id: BigInt(config.seeding_channel_id)
        }
      );
  }

  await discordClient.login(environment.DISCORD_BOT_TOKEN);
  const guilds = await discordClient.guilds.fetch();
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

  // create sign up message
  const signUpFieldIds = {
    notifyWhen: 'notifyWhen',
    signUpButton: 'signUp-' + uuidv4()
  };
  let signUpMessage$: discord.Message = await (async () => {
    const channel = await discordClient.channels.fetch(config.seeding_channel_id);
    if (!channel!.isTextBased()) {
      throw new Error('seeding channel should be text based');
    }
    const signUpButton = new ButtonBuilder()
      .setCustomId(signUpFieldIds.signUpButton)
      .setLabel('Sign Up')
      .setStyle(ButtonStyle.Primary);

    const notifyWhenSelectMenu = new SelectMenuBuilder()
      .setCustomId(signUpFieldIds.notifyWhen)
      .setPlaceholder('Nothing Selected')
      .addOptions(
        {
          label: 'Online',
          value: '0'
        },
        {
          label: 'Playing',
          value: '1'
        },
        {
          label: 'Always',
          value: '2'
        },
        {
          label: 'Never',
          value: '3'
        }
      );


    const notificationsRow = new ActionRowBuilder<SelectMenuBuilder>().addComponents(notifyWhenSelectMenu);
    const signUpRow = new ActionRowBuilder<ButtonBuilder>().addComponents(signUpButton);

    const c = channel as TextChannel;
    const content = 'Sign up for server seeding to earn rewards!';
    if (instanceTenant.signup_message_id) {
      let msg = await c.messages.fetch(instanceTenant.signup_message_id.toString());
      msg = await msg.edit({
        content: content,
        components: [signUpRow]
      });
      await schema.tenant(db).update({ id: instanceTenant.id }, { signup_message_id: BigInt(msg.id) });
      return msg;
    } else {
      const msg = await c.send({
        content: content,
        components: [signUpRow]
      });
      await schema.tenant(db).update({ id: instanceTenant.id }, { signup_message_id: BigInt(msg.id) });
      return msg;
    }
  })();

  {
    const serversInDb = await schema.server(db).select({ tenant_id: instanceTenant.id }).all();

    for (let configured of config.servers) {
      await schema.server(db).insertOrUpdate(['id'], {
        ...configured,
        tenant_id: instanceTenant.id
      });
    }
    for (let s of serversInDb) {
      if (!config.servers.map(s => s.id).includes(s.id)) {
        await schema.server(db).delete({ id: s.id });
      }
    }


    const allServers = await schema.server(db).select({}).all();
    const steam = new SteamAPI(environment.STEAM_API_KEY);
    console.table(allServers);

    let seeder$: ConnectableObservable<Change<Seeder>>;
    {
      const existingSeeder$ = from(await schema.seeder(db).select().all()).pipe(map((s): Change<Seeder> => ({
        type: 'added',
        elt: s
      })));
      const signupModalIds = {
        steamId: 'steamId'
      };
      getInteractionObservable(discordClient).subscribe(
        // get seeder from interaction
        async (rawInteraction) => {
          if (!rawInteraction.isButton()) return;
          const interaction = rawInteraction as ButtonInteraction;
          if (interaction.customId !== signUpFieldIds.signUpButton) return;
          await interaction.deferReply({ ephemeral: true });
          const alreadyExists = (await schema.seeder(db).count({ discord_id: BigInt(interaction.user.id) })) > 0;
          if (alreadyExists) {
            await interaction.editReply({ content: 'You\'re already signed up!' });
            return;
          }
          await interaction.deleteReply();

          let modalBuilder: ModalBuilder;


          // build modal
          {
            modalBuilder = new ModalBuilder();
            modalBuilder
              .setTitle('Sign Up')
              .setCustomId('sign-up-modal');


            const steamIdTextInput = new TextInputBuilder()
              .setCustomId(signupModalIds.steamId)
              .setLabel('Steam Id')
              .setRequired(true)
              .setStyle(TextInputStyle.Short);


            modalBuilder.addComponents([
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(steamIdTextInput)
            ]);
            await interaction.showModal(modalBuilder);
          }
        }
      );

      let newSeeder$: ConnectableObservable<Change<Seeder>>;
      {
        const o: Observable<Change<Seeder>> = getInteractionObservable(discordClient).pipe(
          mergeMap(async (rawInteraction): Promise<Change<Seeder> | undefined> => {
            if (!rawInteraction.isModalSubmit()) return;
            const interaction = rawInteraction as ModalSubmitInteraction;
            const rawSteamId = interaction.fields.getTextInputValue(signupModalIds.steamId).trim();
            const steamId = BigInt(rawSteamId);
            if (!(steamId)) throw new InteractionError('steamId is invalid', interaction);
            try {
              await steam.getUserSummary([rawSteamId]);
              // TODO: perform 0auth authentication to ensure user actually owns account for steamId
            } catch (err) {
              if (!(err instanceof Error) || (err instanceof InteractionError) || !err.message.includes('No players found')) throw err;
              throw new InteractionError(`unable to find steam user with id ${steamId} `, interaction);
            }

            await schema.player(db).insertOrIgnore({ steam_id: steamId });
            try {
              const [newSeeder] = await schema.seeder(db).insert({
                steam_id: steamId,
                discord_id: BigInt(interaction.user.id),
                notify_when: 1
              });
              return { elt: newSeeder, type: 'added' };
            } catch (err: any) {
              if (err.code === '23505') {
                throw new InteractionError('you\'re already signed up!', interaction);
              }
              throw err;
            }
            return;
          }),
          // avoid duplicating database entries
          share(),
          catchError((err, o) => o),
          concatMap(m => !!m ? of(m) : EMPTY)
        );
        newSeeder$ = new ConnectableObservable(o, () => new Subject());
      }


      newSeeder$.pipe(
        filter(c => c.type === 'added'),
        map(c => c.elt)
      ).subscribe(async addedSeeder => {
        const members = await guild.members.fetch({});
        for (let member of members.values()) {
          if (member.id !== addedSeeder.id.toString()) continue;
          member.send('test');
          break;
        }
      });

      const updatedSeeder$: Observable<Change<Seeder>> = getInteractionObservable(discordClient).pipe(
        mergeMap(async (rawInteraction): Promise<Change<Seeder> | undefined> => {
          if (rawInteraction.isSelectMenu()) return;
          const interaction = rawInteraction as Interaction as SelectMenuInteraction;
          if (interaction.customId !== signUpFieldIds.notifyWhen) return;
          const notifyWhen = parseInt(interaction.values[0]);
          const seeder = allSeedersByDiscordId.get(BigInt(interaction.user.id));
          if (!seeder) return;
          const [updated] = await schema.seeder(db).update({ id: seeder.id }, { notify_when: notifyWhen });
          return {
            elt: updated,
            type: 'updated'
          };
        }),
        share(),
        // ignore falsy values
        concatMap(m => !!m ? of(m) : EMPTY)
      );
      const allSeeder$ = of(existingSeeder$, newSeeder$).pipe(concatAll());

      seeder$ = new ConnectableObservable(of(allSeeder$, updatedSeeder$).pipe(mergeAll()), () => new Subject());
      newSeeder$.connect();
    }

    let allSeedersByDiscordId: Map<bigint, Seeder>;
    {
      allSeedersByDiscordId = new Map();
      seeder$.subscribe(seeder => {
        allSeedersByDiscordId.set(seeder.elt.discord_id, seeder.elt);
      });
    }

    await Promise.all(allServers.map(async (s) =>
      setupServer(s, discordClient, steam, instanceTenant, db, seeder$, allSeedersByDiscordId)
    ));

    seeder$.connect();
  }
}

function registerInteractions() {

}


try {
  main();
} catch (err) {
  console.log(err);
}
