import { ConnectionPool, sql } from '@databases/pg';
import { DiscordAPIError, REST } from '@discordjs/rest';
import { Mutex } from 'async-mutex';
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
  ModalSubmitInteraction,
  ActivityType
} from 'discord.js';
import {
  ConnectableObservable,
  EMPTY,
  from,
  Observable,
  of,
  Subject,
  throwError,
  combineLatest,
  connectable,
  Connectable, Subscription
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
  mergeAll,
  distinct,
  takeWhile,
  startWith,
  withLatestFrom
} from 'rxjs/operators';
import SteamAPI from 'steamapi';
import { Seeder, Server, Tenant } from './__generated__';
import { accumulateMap, flattenDeferred, getElt } from './asyncUtils';
import { config } from './config';
import { getConfiguredConnectionPool } from './db';
import * as schema from './db';
import {
  getInteractionObservable,
  getPresenceObservable
} from './discordUtils';
import { Environment, environment } from './environment';
import {
  registerInputObservable,
  addSubToMaster,
  tryToFlushInputObservables
} from './cleanup';
import { steamClient } from './globalServices';
import { InteractionError } from './interactionError';
import { Change } from './manageSeeders';
import { NotifyWhen, SeederResponse } from './models';
import { setupServer } from './setupServer';
import { v4 as uuidv4 } from 'uuid';


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


function main() {
  let db: ConnectionPool = getConfiguredConnectionPool();
  // const masterSub: Subscription = new Subscription();

  let deferredDiscordClient: Promise<discord.Client> = (async () => {
    const client = new discord.Client({ intents: ['GuildMembers', 'Guilds', 'GuildMessages'] });
    await client.login(environment.DISCORD_BOT_TOKEN);
    return client;
  })();


  let deferredInstanceTenant: Promise<Tenant> = (async () => {
    // get tenant info
    const [instanceTenant] = await schema.tenant(db)
      .insertOrUpdate(
        ['guild_id'],
        {
          guild_id: BigInt(config.guild_id),
          seed_channel_id: BigInt(config.seeding_channel_id)
        }
      );
    return instanceTenant;
  })();


  const _observeNotifiable = (discordId: bigint, steamId: bigint, notifySetting$: Observable<NotifyWhen>) => {
    return from(Promise.all([deferredDiscordClient, deferredInstanceTenant])).pipe(
      mergeMap(([discordClient, tenant]) => observeNotifiable(discordClient, tenant, discordId, steamId, notifySetting$))
    );
  };


  const discordCommandsRegistered: Promise<void> = (async function registerDiscordCommands() {
    const instanceTenant = await deferredInstanceTenant;
    // register application commands
    const commands = [
      new SlashCommandBuilder().setName('sm-configure-server').setDescription('reconfigure an existing server')
        .addSubcommand((cmd) => cmd.setName('add').setDescription('Configure a new server'))
    ];
    const rest = new REST({ version: '10' }).setToken(environment.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(config.discord_client_id.toString(), instanceTenant.guild_id.toString()), { body: commands });
    console.log('successfully registered application commands');
  })();

  // create sign up message
  const signUpFieldIds = {
    notifyWhen: 'notifyWhen',
    signUpButton: 'signUp',
    unregisterButton: 'unregister'
  };


  const serversDeferred = (async () => {
    const instanceTenant = await deferredInstanceTenant;
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
    return schema.server(db).select({}).all();
  })();


  function buildSignupMessageOptions() {
    const signUpButton = new ButtonBuilder()
      .setCustomId(signUpFieldIds.signUpButton)
      .setLabel('Sign Up')
      .setStyle(ButtonStyle.Primary);

    const unregisterButton = new ButtonBuilder()
      .setCustomId(signUpFieldIds.unregisterButton)
      .setLabel('Unregister')
      .setStyle(ButtonStyle.Danger);

    const signUpRow = new ActionRowBuilder<ButtonBuilder>().addComponents(signUpButton, unregisterButton);
    const content = 'Sign up for server seeding to earn rewards!';
    return {
      content,
      components: [signUpRow]
    };
  }


  // discord user ids
  const usersToPromptForSignup$: Subject<bigint> = new Subject();
  (function promptSignups() {
    const signupMtx = new Mutex();
    addSubToMaster(usersToPromptForSignup$, {
      next: async discordId => {
        await signupMtx.acquire();
        try {
          const discordClient = await deferredDiscordClient;
          const [{ count }] = (await db.query(sql`SELECT COUNT(*)
                                                  FROM users_prompted_for_signup
                                                  WHERE discord_id ? ${discordId}`)) as [{ count: bigint }];

          if (count !== 0n) return;

          const member = await discordClient.guilds
            .fetch((await deferredInstanceTenant).guild_id.toString())
            .then(guild => guild.members.fetch(discordId.toString()));

          const content = 'If you\'d like to be notified when seeding sessions start, please sign up here:';
          const msgOptions = buildSignupMessageOptions();
          await member.send({ ...msgOptions, content: content });
          await schema.users_prompted_for_signup(db).insert({ discord_id: `"${discordId}" => ${discordId.toString()}` });
        } finally {
          signupMtx.release();
        }
      }
    });
  })();

  const seeder$: Connectable<Change<Seeder>> = (function trackAndPersistSeeders() {
    // const [discordClient, signUpMessage] = await Promise.all([deferredDiscordClient, deferredSignUpMessage]);
    const signupModalIds = {
      steamId: 'steamId'
    };
    const seedersFromDb$ = flattenDeferred(schema.seeder(db).select().all().then(seeders => from(seeders)));
    const existingSeeder$ = seedersFromDb$.pipe(map((s): Change<Seeder> => ({
      type: 'added',
      elt: s
    })));
    let interaction$ = flattenDeferred(deferredDiscordClient.then(c => getInteractionObservable(c)));

    let deferredSignUpMessage: Promise<discord.Message> = (async function ensureSignupMessageCreated() {
      const discordClient = await deferredDiscordClient;
      const [instanceTenant, channel] = await Promise.all([deferredInstanceTenant, discordClient.channels.fetch(config.seeding_channel_id)]);
      if (!channel!.isTextBased()) {
        throw new Error('seeding channel should be text based');
      }
      const textChannel = channel as discord.TextChannel;
      ;
      const msgOptions = buildSignupMessageOptions();

      if (!instanceTenant.signup_message_id) {

      }

      const persistMessageId = (msg: discord.Message) => schema.tenant(db).update({ id: instanceTenant.id }, { signup_message_id: BigInt(msg.id) });
      if (!instanceTenant.signup_message_id) {
        const msg = await textChannel.send(msgOptions);
        await persistMessageId(msg);
        return msg;
      }

      let msg: discord.Message;
      try {
        msg = await textChannel.messages.fetch(instanceTenant.signup_message_id.toString());
      } catch (err: any) {
        if (err instanceof DiscordAPIError && err.code === 10008) {
          const msg = await textChannel.send(msgOptions);
          await persistMessageId(msg);
          return msg;
        }
        throw err;
      }
      await persistMessageId(msg);
      msg = await msg.edit(msgOptions);
      return msg;
    })();

    (function observeSignUpButton() {
      addSubToMaster(
        interaction$,
        {
          // get seeder from interaction
          next: async (rawInteraction) => {
            if (!rawInteraction.isButton() || rawInteraction.message.id !== (await deferredSignUpMessage).id) return;
            const interaction = rawInteraction as ButtonInteraction;
            if (interaction.customId !== signUpFieldIds.signUpButton) return;
            const alreadyExists = (await schema.seeder(db).count({ discord_id: BigInt(interaction.user.id) })) > 0;
            if (alreadyExists) {
              await interaction.reply({
                content: 'You\'re already signed up!',
                ephemeral: true
              });
              return;
            }

            // build modal
            let modalBuilder: ModalBuilder;
            {
              modalBuilder = new ModalBuilder();
              modalBuilder
                .setTitle('Sign Up')
                .setCustomId('sign-up-modal-' + uuidv4());


              const steamIdTextInput = new TextInputBuilder()
                .setCustomId(signupModalIds.steamId)
                .setLabel('Steam Id')
                .setRequired(true)
                .setStyle(TextInputStyle.Short);


              modalBuilder.addComponents([
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(steamIdTextInput)
              ]);
            }

            await interaction.showModal(modalBuilder);

          }
        }
      );
    })();


    const newSeeder$: Observable<Change<Seeder>> = (function observeSignUpModalSubmission() {
      return interaction$.pipe(
        mergeMap(async (rawInteraction): Promise<Change<Seeder> | undefined> => {
          if (!rawInteraction.isModalSubmit() || rawInteraction.message!.id !== (await deferredSignUpMessage).id) return;
          const interaction = rawInteraction as ModalSubmitInteraction;
          const rawSteamId = interaction.fields.getTextInputValue(signupModalIds.steamId).trim();
          const steamId = BigInt(rawSteamId);
          if (!steamId) throw new InteractionError('steamId is invalid', interaction);
          try {
            await steamClient.getUserSummary([rawSteamId]);
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
    })();
    const updatedSeeder$: Observable<Change<Seeder>> = interaction$.pipe(
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
      // ignore falsy values
      concatMap(m => !!m ? of(m) : EMPTY)
    );

    const removedSeeder$: Observable<Change<Seeder>> = (function observeUnregisterButton() {
      return interaction$.pipe(
        withLatestFrom(deferredSignUpMessage),
        mergeMap(async ([rawInteraction, signUpMessage]): Promise<Observable<Seeder>> => {
          if (!rawInteraction.isButton() || rawInteraction.message.id !== signUpMessage.id || (rawInteraction as ButtonInteraction).customId !== signUpFieldIds.unregisterButton) return EMPTY;
          const discordId = BigInt(rawInteraction.user.id);
          const seeder = allSeedersByDiscordId.get(discordId) as Seeder;
          await schema.seeder(db).delete({ discord_id: discordId });
          return !!seeder ? of(seeder) : EMPTY;
        }),
        mergeAll(),
        map(elt => ({ type: 'removed', elt }))
      );
    })();

    const allSeeder$ = of(existingSeeder$, newSeeder$, removedSeeder$).pipe(concatAll());
    return connectable(of(allSeeder$, updatedSeeder$).pipe(mergeAll()));
  })();

  const notifiableSeeder$: Observable<Change<Seeder>> = (function observeNotifiableSeeders() {
    return seeder$.pipe(mergeMap((seederChange) => {
      switch (seederChange.type) {
        case 'added': {
          const changesForSeeder$ = seeder$.pipe(
            filter(s => s.elt.id === seederChange.elt.id),
            takeWhile(s => s.type !== 'removed')
          );
          const updated$ = changesForSeeder$.pipe(filter(s => s.type === 'updated'));
          const notifyWhen$: Observable<NotifyWhen> = updated$.pipe(map(({ elt }) => elt.notify_when), startWith(seederChange.elt.notify_when), distinct());
          const shouldNotify$ = _observeNotifiable(seederChange.elt.discord_id, seederChange.elt.steam_id, notifyWhen$);
          return shouldNotify$.pipe(map(shouldNotify => ({
            elt: seederChange.elt,
            type: shouldNotify ? 'added' : 'removed'
          } as Change<Seeder>)));
        }
        default: {
          return EMPTY;
        }
      }
    }));
  })();
  // map tracking all seeders TODO: eventually stop storing all seeders in process memory
  const allSeedersByDiscordId: Map<bigint, Seeder> = new Map();
  const allSeedersBySteamId: Map<bigint, Seeder> = new Map();
  addSubToMaster(seeder$, { next: accumulateMap(allSeedersBySteamId, s => s.discord_id) });
  addSubToMaster(seeder$, { next: accumulateMap(allSeedersByDiscordId, s => s.steam_id) });

  (function setupServers() {
    serversDeferred.then(servers => {
      for (let server of servers) {
        const {
          serverSeedSignupAttempt$
        } = setupServer(
          server,
          deferredDiscordClient,
          deferredInstanceTenant,
          db,
          seeder$,
          notifiableSeeder$,
          allSeedersByDiscordId,
          allSeedersBySteamId
        );

        addSubToMaster(serverSeedSignupAttempt$, usersToPromptForSignup$);
      }
    });
  })();
  seeder$.connect();
}

function observeNotifiable(discordClient: discord.Client, tenant: Tenant, discordId: bigint, steamId: bigint, notifySetting$: Observable<NotifyWhen>): Observable<boolean> {
  const presenceUpdate$ = getPresenceObservable(discordClient).pipe(filter(p => p.userId === discordId.toString()));
  const currentPresence$ = discordClient.guilds
    .fetch(tenant.guild_id.toString())
    .then(guild => guild.members.fetch(discordId.toString()))
    .then(member => member.presence as discord.Presence);

  const presence$ = of(currentPresence$, presenceUpdate$).pipe(mergeAll());
  return combineLatest(presence$, notifySetting$).pipe(
    map(([presence, notify]): boolean => {
      switch (notify) {
        case NotifyWhen.Always:
          return true;
        case NotifyWhen.Never:
          return false;
        case NotifyWhen.Online:
          return presence.status === 'online';
        case NotifyWhen.Playing:
          return presence.activities.map(a => a.type).includes(ActivityType.Playing);
      }
    }),
    distinct()
  );
}

process.on('SIGTERM', async () => {
  await tryToFlushInputObservables();
  process.exit(0);
});

main();

