import { ConnectionPool } from '@databases/pg';
import { Mutex } from 'async-mutex';
import discord, {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
  MessageOptions,
  TextChannel
} from 'discord.js';
import GameDig from 'gamedig';
import {
  BehaviorSubject,
  asyncScheduler,
  combineLatest,
  ConnectableObservable,
  EMPTY,
  from,
  interval,
  Observable,
  of,
  Subject,
  Subscription
} from 'rxjs';
import {
  concatMap,
  observeOn,
  filter,
  map,
  mergeMap,
  share,
  mergeAll,
  switchMap,
  withLatestFrom
} from 'rxjs/operators';
import SteamAPI from 'steamapi';
import { addSubToMaster } from './cleanup';
import {
  Player,
  Seeder,
  SeedSessionLog,
  Server,
  Tenant
} from './__generated__';
import {
  DeferredBehaviorSubject,
  flattenDeferred,
  getFirstAfterDeferred,
  mapChange,
  scanChangesToMap,
  trackUnifiedState
} from './asyncUtils';
import { config } from './config';
import * as schema from './db';
import { observeMessageReactions } from './discordUtils';
import { registerInputObservable } from './cleanup';
import { Change } from './manageSeeders';
import { getServerPlayerChange$, queryGameServer } from './squadServer';
import { isNonNulled } from './typeUtils';

export class SetupServer {
  // avoid top level awaits in setup
}


export function setupServer(server: Server,
                            discordClientDeferred: Promise<discord.Client>,
                            tenantDeferred: Promise<Tenant>,
                            db: ConnectionPool,
                            seeder$: Observable<Change<Seeder>>,
                            notifiableSeeder$: Observable<Change<Seeder>>,
                            allSeedersByDiscordId: Map<bigint, Seeder>,
                            allSeedersBySteamId: Map<bigint, Seeder>) {
  const deferredChannel: Promise<TextChannel> = (async () => {
    const channel = await (await discordClientDeferred).channels.fetch(config.seeding_channel_id);
    if (channel === null) {
      throw new Error(`seed channel for server ${server.host}:${server.query_port} does not exist`);
    }
    return channel as discord.TextChannel;
  })();


  // fetch game server updates on an interval
  const deferredGameServerUpdate$: DeferredBehaviorSubject<GameDig.QueryResult> = (async function observeGameServerUpdates() {
    const getResource = () => queryGameServer(server.host, server.query_port);
    const sub: BehaviorSubject<GameDig.QueryResult> = new BehaviorSubject(await getResource());
    const updates = interval(10000).pipe(switchMap(async () => getResource()), registerInputObservable());
    addSubToMaster(sub);
    return sub;
  })();

  let deferredServerMessage$: DeferredBehaviorSubject<discord.Message<boolean>> = (async function setupServerMessage() {
    const ids = { signUpButton: 'signUp' };
    const channel = await deferredChannel;
    let msg: discord.Message<boolean> | null = null;
    {
      const messages = [...await channel.messages.fetch().then(msgs => msgs.values())];
      msg = messages.find(msg => isServerMessage(msg, server.id)) || null;
    }

    const gameServerState = await getFirstAfterDeferred(deferredGameServerUpdate$);

    // represents the ongoing state of the message
    const embedBuilder = new EmbedBuilder()
      .setTitle(`${gameServerState.name} (${server.id})`);

    const signUpButton = new ButtonBuilder()
      .setCustomId(ids.signUpButton)
      .setLabel('Sign Up')
      .setStyle(ButtonStyle.Secondary);

    const builtMessage: MessageOptions = {
      components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(signUpButton)],
      embeds: [embedBuilder]
    };

    if (!msg) {
      msg = await (await channel)!.send(builtMessage);
    } else {
      msg = await msg.edit({
        components: builtMessage.components,
        embeds: builtMessage.embeds,
        content: builtMessage.content
      });
    }

    if (msg === null) {
      throw new Error('failed to set up serverMessage');
    }
    return new BehaviorSubject(msg);
  })();

  // lock mutex when subsequently reading and then writing a message to avoid writing stale values

  (function trackDisplayedServerStatus() {
    const msgMutex: Mutex = new Mutex();
    addSubToMaster(flattenDeferred(deferredGameServerUpdate$), {
      next: (
        async (gameServer) => {
          await msgMutex.runExclusive(async () => {

            const serverMessage$ = await deferredServerMessage$;
            const msg = await serverMessage$.value.fetch();
            const embed = msg.embeds[0];

            let field: discord.APIEmbedField | undefined = embed.fields.find(f => f.name.startsWith('Status: '));
            if (!field) {
              field = { name: 'Status: ', value: '' };
              embed.fields.push(field as discord.APIEmbedField);
            }

            field.value = formatStatusField(gameServer.players.length, gameServer.maxplayers, server.seed_min_players as number);
            serverMessage$.next(await msg!.edit({ embeds: [embed] }));
          });
        }
      )
    });
  })();

  const messageReaction$ = flattenDeferred(
    Promise.all([discordClientDeferred, getFirstAfterDeferred(deferredServerMessage$)])
      .then(([client, msg]) => observeMessageReactions(client, msg))
  );

  const seedSignupAttempt$: Observable<bigint> = (function observeSignupAttempts() {
    return messageReaction$.pipe(
      filter(change => change.type === 'added'),
      map(change => change.elt),
      mergeMap((elt) => {
        if (allSeedersByDiscordId.has(elt.userId)) return EMPTY;
        return of(BigInt(elt.userId));
      })
    );
  })();

  // manage and record seeding sessions
  (function setupSeeding() {

    const serverSeeder$: Observable<Change<Seeder>> = ((() => {
      // listen for seeder reactions and track on the database
      // let  = getFirstAfterDeferred(deferredServerMessage$);


      return messageReaction$.pipe(
        withLatestFrom(flattenDeferred(deferredServerMessage$)),
        mergeMap(async ([reactionChange, serverMessage]): Promise<Change<Seeder> | undefined> => {
          const { reaction, userId } = reactionChange.elt;
          if (reaction.message.id !== serverMessage.id) throw new Error('unable to locate server reaction message');
          const seeder = allSeedersByDiscordId.get(BigInt(userId));
          if (!seeder) return;
          switch (reactionChange.type) {
            case 'added': {
              await schema.server_seeder(db).insert({
                server_id: server.id,
                seeder_id: seeder.id
              });
              return {
                elt: seeder,
                type: 'added'
              } as Change<Seeder>;
            }
            case 'removed': {
              await schema.server_seeder(db).delete({
                server_id: server.id,
                seeder_id: seeder.id
              });
              return {
                elt: seeder,
                type: 'removed'
              };
            }
            case 'updated': {
              return {
                elt: seeder,
                type: 'updated'
              };
            }
          }
          return;
        }),
        // remove falsy values
        concatMap(c => !!c ? of(c) : EMPTY)
      );
    })());


    const activePlayer$: Observable<Change<Player>> = (function trackAndPersistActivePlayers() {
      const playerMtx = new Mutex();
      return getServerPlayerChange$(server).pipe(
        concatMap(async (playerChange): Promise<Change<Player> | null> => {
          const steamId = BigInt(playerChange.elt.steamID);
          switch (playerChange.type) {
            case 'added': {
              await playerMtx.acquire();
              try {
                await schema.player(db).insertOrUpdate(['steam_id'], { steam_id: steamId });
              } finally {
                playerMtx.release();
              }
              return ({
                type: 'added',
                elt: { steam_id: steamId }
              } as Change<Player>);
            }
            case 'removed': {
              return {
                type: 'removed',
                elt: { steam_id: steamId }
              } as Change<Player>;
            }
            default: {
              return null;
            }
          }
        }),
        filter(isNonNulled)
      );
    })();
    const notifiableServerSeeder$: Observable<Change<Seeder>> = (function observeNotifiableServerSeeders() {
      return from([
        serverSeeder$,
        notifiableSeeder$,
        activePlayer$
      ] as Observable<Change<Seeder>>[]).pipe(
        map(mapChange(elt => elt.steam_id)),
        // ensure
        trackUnifiedState([true, true, false]),
        mapChange(steamId => allSeedersByDiscordId.get(steamId) as Seeder)
      );
    })();
    const activeSeedSession$: Observable<SeedSessionLog | null> = (function trackAndPersistSeedSessions() {
      let activeSessionId: number | null;
      const activeSessionMtx = new Mutex();
      const seedSession$ = combineLatest([
        activePlayer$.pipe(scanChangesToMap(elt => elt.steam_id)),
        notifiableServerSeeder$.pipe(scanChangesToMap(elt => elt.steam_id))
      ]).pipe(
        mergeMap(async ([players, seeders]): Promise<Change<SeedSessionLog> | null> => {
          const uniquePlayers = new Set([...players.keys(), ...seeders.keys()]);

          // TODO: improve heuristics for calulating when to start/abort a seed session
          const inThreshold = server.seed_min_players <= uniquePlayers.size && uniquePlayers.size <= server.seed_max_players;
          const activeSession = activeSessionId !== null;
          if (!activeSession && inThreshold) {
            await activeSessionMtx.acquire();
            let insertedSessionLog: SeedSessionLog;
            try {
              [insertedSessionLog] = await schema.seed_session_log(db).insert({
                server_id: server.id,
                start_time: new Date()
              });
            } finally {
              activeSessionMtx.release();
            }

            activeSessionId = insertedSessionLog!.id;
            return {
              elt: insertedSessionLog,
              type: 'added'
            } as Change<SeedSessionLog>;
          }
          if (activeSession && !inThreshold) {
            let updatedSessionLog: SeedSessionLog;
            await activeSessionMtx.acquire();
            try {
              [updatedSessionLog] = await schema.seed_session_log(db).update({ id: activeSessionId as number }, { end_time: new Date() });
            } finally {
              activeSessionMtx.release();
            }
            activeSessionId = null;
            return ({
              elt: updatedSessionLog,
              type: 'removed'
            });
          }

          return null;
        }),
        filter(isNonNulled)
      );
      const bs = new BehaviorSubject<SeedSessionLog | null>(null);
      const newSession$ = seedSession$.pipe(map(c => c.type === 'added' ? c.elt : null));
      addSubToMaster(newSession$);
      return bs;
    })();


    const notifiedSeeder$ = (function notifyAvailableSeeders(): Observable<Seeder> {
      const deferredGuild = Promise.all([discordClientDeferred, tenantDeferred]).then(([client, tenant]) => client.guilds.fetch(tenant.guild_id.toString()));
      return activeSeedSession$.pipe(
        filter(isNonNulled),
        withLatestFrom(notifiableServerSeeder$.pipe(scanChangesToMap(seeder => seeder.discord_id))),
        mergeMap(async ([session, seeders]) => {
          const serverName = (await getFirstAfterDeferred(deferredGameServerUpdate$)).name;
          const sent = [...seeders.values()].map(seeder => deferredGuild
            .then(guild => guild.members.fetch(seeder.discord_id.toString()))
            .then(member => member.send('Time to seed ' + serverName))
            .then(() => seeder)
          );
          return from(sent);
        }),
        mergeAll(),
        mergeAll(),
        share()
      );
    })();
    addSubToMaster(notifiedSeeder$);

  })();


  return {
    serverSeedSignupAttempt$: seedSignupAttempt$
  };
}

function formatStatusField(length: number, maxplayers: any, seed_threshold: number) {
  return '';
}

function isServerMessage(msg: discord.Message, serverId: number): boolean {
  let embed = msg.embeds[0];
  // TODO: improve message id solution
  return !!(embed?.title?.includes(`(${serverId})`));
}
