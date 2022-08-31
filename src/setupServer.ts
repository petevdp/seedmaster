import { ConnectionPool } from '@databases/pg';
import { Mutex } from 'async-mutex';
import discord, {
  Message,
  MessageEditOptions,
  MessageOptions,
  TextChannel
} from 'discord.js';
import GameDig from 'gamedig';
import {
  BehaviorSubject,
  combineLatest,
  EMPTY,
  from,
  interval,
  Observable,
  of,
  Subject,
  timer
} from 'rxjs';
import {
  concatMap,
  filter,
  map,
  mergeAll,
  mergeMap,
  share,
  switchMap,
  tap,
  withLatestFrom
} from 'rxjs/operators';
import { Seeder, SeedSessionLog, Server, Tenant } from './__generated__';
import { addSubToMaster, registerInputObservable } from './cleanup';
import { config } from './config';
import * as schema from './db';
import { seed_session_log } from './db';
import {
  editServerSeedMessageMapName,
  editServerSeedMessagePlayerCount,
  playerJoinedSession,
  seedSessionStart,
  serverSeedMessage
} from './discordComponents';
import { logger, ppObj } from './globalServices/logger';
import {
  accumulateMap,
  Change,
  changeOfType,
  DeferredBehaviorSubject,
  flattenDeferred,
  Future,
  getFirstAfterDeferred,
  mapChange,
  ResourceChange,
  scanChangesToMap,
  trackUnifiedState
} from './lib/asyncUtils';
import { observeMessageReactions } from './lib/discordUtils';
import { isNonNulled } from './lib/typeUtils';
import { EndReason } from './manageSeeders';
import {
  MessageWithRole,
  PlayerWithDetails,
  SeedSessionEndReason,
  ServerMessageRole
} from './models';
import { observeSquadServer, queryGameServer } from './squadServer';

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
    addSubToMaster(sub, 'deferredGameServerUpdate');
    return sub;
  })();

  const activePlayer$: Observable<Change<PlayerWithDetails>> = (function trackAndPersistActivePlayers() {
    const playerMtx = new Mutex();
    const o = observeSquadServer(server).pipe(
      concatMap(async (playerChange): Promise<Change<PlayerWithDetails> | null> => {
        const steamId = BigInt(playerChange.elt.steamID);

        const player: PlayerWithDetails = {
          steam_id: steamId,
          ...playerChange.elt
        };

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
              elt: player
            } as Change<PlayerWithDetails>);
          }
          case 'removed': {
            return {
              type: 'removed',
              elt: player
            } as Change<PlayerWithDetails>;
          }
          default: {
            return null;
          }
        }
      }),
      filter(isNonNulled),
      tap(change => logger.info(`${change.type} ${change.elt.name} (${change.elt.steam_id})`, change)),
      share()
    );
    addSubToMaster(o, 'trackAndPersistActivePlayers');
    return o;
  })();
  const activePlayers = new Map<bigint, PlayerWithDetails>();
  addSubToMaster(activePlayer$, 'accumulateActivePlayers', { next: accumulateMap(activePlayers, player => player.steam_id) });
  addSubToMaster(activePlayer$, 'countActivePlayers', { next: () => logger.info(`num active players: ${activePlayers.size}`) });

  type MessageChange = ResourceChange<{ options: MessageOptions; role: ServerMessageRole }, string, { options: MessageEditOptions; role: ServerMessageRole }, Message>;
  const {
    serverMessagesDeferred,
    sendManagedMessage,
    removeManagedMessage,
    editManagedMessage
  } = (function manageChannelMessages() {
    const messageMutexesDeferred = new Future<Map<bigint, Mutex>>();
    const serverMessagesDeferred: Future<Map<bigint, MessageWithRole>> = new Future();

    async function sendManagedMessage(options: MessageOptions, role: ServerMessageRole) {
      const channel = await deferredChannel;
      const msg = await channel.send(options);
      let messageId = BigInt(msg.id);
      await schema.server_managed_message(db).insert({
        server_id: server.id,
        channel_id: BigInt(channel.id),
        message_id: messageId,
        role: role
      });
      (await messageMutexesDeferred).set(messageId, new Mutex());
      let messageWithRole = { msg, role };
      (await serverMessagesDeferred).set(messageId, messageWithRole);
      return msg;
    }

    async function editManagedMessage(messageId: bigint, options: MessageEditOptions) {
      const mutex = (await messageMutexesDeferred).get(messageId);
      if (!mutex) {
        throw new Error('trying to edit message that is not tracked');
      }
      await mutex.acquire();
      try {
        const channel = await deferredChannel;
        const msg = await channel.messages.fetch(messageId.toString());
        await msg.edit(options);
        let role = (await serverMessagesDeferred).get(messageId)!.role;
        (await serverMessagesDeferred).set(messageId, { role, msg });
        return msg;
      } finally {
        mutex.release();
      }
    }

    async function removeManagedMessage(messageId: bigint) {
      const mutex = (await messageMutexesDeferred).get(messageId);
      if (!mutex) {
        throw new Error('trying to delete message that is not tracked');
      }
      const channel = await deferredChannel;
      await mutex.acquire();
      try {
        const msg = await channel.messages.fetch(messageId.toString());
        await msg.delete();
        await schema.server_managed_message(db).delete({
          server_id: server.id,
          channel_id: BigInt(channel.id),
          message_id: messageId
        });
        (await messageMutexesDeferred).delete(messageId);
        (await serverMessagesDeferred).delete(messageId);
        return msg;
      } finally {
        mutex.release();
      }
    }

    (async function loadMessagesFromDatabase() {
      const rows = await schema.server_managed_message(db).select({
        server_id: server.id,
        channel_id: BigInt((await deferredChannel).id)
      }).all();

      const channel = await deferredChannel;
      const messages = await Promise.all(rows.map(async (row): Promise<MessageWithRole> => ({
        msg: await channel.messages.fetch(row.message_id.toString()),
        role: row.role
      })));
      const msgMap = new Map(messages.map(elt => [BigInt(elt.msg.id), elt]));
      const msgMtx = new Map(messages.map(elt => [BigInt(elt.msg.id), new Mutex()]));
      messageMutexesDeferred.resolve(msgMtx);
      serverMessagesDeferred.resolve(msgMap);
    })();

    const serverMessages = serverMessagesDeferred as Promise<ReadonlyMap<bigint, MessageWithRole>>;
    return {
      sendManagedMessage,
      editManagedMessage,
      removeManagedMessage,
      serverMessagesDeferred: serverMessages
    };
  })();

  const mainServerMessageDeferred = (async function ensureMainServerMessageExists() {
    const ids = { signUpButton: 'signUp' };
    const channel = await deferredChannel;
    let msgWithRole = [...(await serverMessagesDeferred).values()].find((elt) => elt.role === ServerMessageRole.Main) || null;

    const gameServerState = await getFirstAfterDeferred(deferredGameServerUpdate$);
    const builtMessage = serverSeedMessage(gameServerState.name, activePlayers.size);
    let msg = msgWithRole?.msg;
    if (msg) {
      msg = await editManagedMessage(BigInt(msg.id), builtMessage as MessageEditOptions);
    } else {
      msg = await sendManagedMessage(builtMessage, ServerMessageRole.Main);
    }
    return msg;
  })();

  const messageReaction$ = flattenDeferred(
    Promise.all([discordClientDeferred, mainServerMessageDeferred])
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
        withLatestFrom(mainServerMessageDeferred),
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
    const notAttendingSeederSubject = new Subject<Seeder>();
    const seedSession$: Observable<Change<SeedSessionLog>> = (function trackAndPersistSeedSessions() {
      let activeSessionId: number | null;
      const activeSessionMtx = new Mutex();
      const notAttendingChange$ = notAttendingSeederSubject.pipe(map(seeder => ({
        type: 'removed',
        elt: seeder
      } as Change<Seeder>)));
      const possiblyAttendingSeeder$ = of(notifiableServerSeeder$, notAttendingChange$).pipe(mergeAll());

      return combineLatest([
        activePlayer$.pipe(scanChangesToMap(elt => elt.steam_id)),
        possiblyAttendingSeeder$.pipe(scanChangesToMap(elt => elt.steam_id))
      ]).pipe(
        mergeMap(async ([players, seeders]): Promise<Change<SeedSessionLog> | null> => {
          const uniquePlayers = new Set([...players.keys(), ...seeders.keys()]);

          const adjustedPlayerCount = server.player_threshold_coefficient * players.size;
          const adjustedSeederCount = server.seeder_threshold_coefficient * seeders.size;
          const adjustedCounts = adjustedSeederCount + adjustedPlayerCount;

          const inStartThreshold = server.seed_start_threshold <= adjustedCounts;
          const inFailedThreshold = server.seed_failed_threshold >= adjustedCounts;
          const hasSuccessPlayerCount = uniquePlayers.size >= server.seed_success_player_count;
          const inActiveSession = activeSessionId !== null;
          let change: Change<SeedSessionLog> | null = null;
          if (!inActiveSession && inStartThreshold) {
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
            change = {
              elt: insertedSessionLog,
              type: 'added'
            };
          }
          if (inActiveSession && inFailedThreshold) {
            let updatedSessionLog: SeedSessionLog;
            await activeSessionMtx.acquire();
            try {
              [updatedSessionLog] = await schema.seed_session_log(db).update({ id: activeSessionId as number }, {
                end_time: new Date(),
                end_reason: SeedSessionEndReason.Failure
              });
            } finally {
              activeSessionMtx.release();
            }
            activeSessionId = null;
            change = ({
              elt: updatedSessionLog,
              type: 'removed'
            });
          }
          if (inActiveSession && hasSuccessPlayerCount) {
            let updatedSessionLog: SeedSessionLog;
            await activeSessionMtx.acquire();
            try {
              [updatedSessionLog] = await schema.seed_session_log(db).update({ id: activeSessionId as number }, {
                end_time: new Date(),
                end_reason: SeedSessionEndReason.Success
              });
            } finally {
              activeSessionMtx.release();
            }
            activeSessionId = null;
            change = {
              elt: updatedSessionLog,
              type: 'removed'
            };
          }

          const data = ({
            uniquePlayers: uniquePlayers.size,
            activePlayers: players.size,
            activeSeeders: seeders.size,
            adjustedPlayerCount,
            adjustedSeederCount,
            combinedCounts: adjustedCounts,
            differenceToStartThreshold: server.seed_start_threshold - adjustedCounts,
            differenceToFailedThreshold: server.seed_failed_threshold - adjustedCounts,
            differenceToEnd: server.seed_success_player_count - uniquePlayers.size
          });
          logger.info(`Tested session: ${ppObj(data)}`);
          logger.info(`session change outcome: ${change?.type || 'nothing'} ${ppObj(change || '')}`, change || 'nothing');

          return change;
        }),
        filter(isNonNulled),
        share()
      );
    })();

    const activeSeedSessionSubject = new BehaviorSubject<SeedSessionLog | null>(null);
    addSubToMaster(seedSession$.pipe(changeOfType('added')), 'seedSession', activeSeedSessionSubject);

    // manage completeion of seed sessions
    addSubToMaster(from(seedSession$.toPromise().finally(async () => {
      const session = activeSeedSessionSubject.value;
      if (!session) return;
      await seed_session_log(db).update({ id: session.id }, {
        end_reason: EndReason.Error,
        end_time: new Date()
      });
      logger.warn('Closed off active seed session due to unforseen error');
    })), 'ManageCompletionOfSeedSessions');

    (function updateDisplayedServerDetails() {
      const msgMutex: Mutex = new Mutex();

      (function updateDisplayedMapName() {
        addSubToMaster(flattenDeferred(deferredGameServerUpdate$), 'updateDisplayedMapName', {
          next: (gameServer) =>
            msgMutex.runExclusive(async () => {
              const msg = await mainServerMessageDeferred;
              const options = editServerSeedMessageMapName(msg, gameServer.map);
              options && editManagedMessage(BigInt(msg.id), options);
            })
        });
      })();

      (function updateDisplayedPlayerCount() {
        addSubToMaster(activePlayer$, 'updateDisplayedPlayerCount', {
          next: () =>
            msgMutex.runExclusive(async () => {
              const msg = await mainServerMessageDeferred;
              await editManagedMessage(BigInt(msg.id), editServerSeedMessagePlayerCount(msg, activePlayers.size));
            })
        });
      })();
    })();

    (function manageSeedSessionMessages() {
      const generatedMessages = new Set<bigint>();

      addSubToMaster(activeSeedSessionSubject.pipe(
        filter(isNonNulled),
        concatMap(async session => {
          const serverDetails = await getFirstAfterDeferred(deferredGameServerUpdate$);
          let options = seedSessionStart(serverDetails.name, activePlayers.size, server.seed_success_player_count, session.start_time);
          const msg = await sendManagedMessage(options, ServerMessageRole.SessionStart);
          generatedMessages.add(BigInt(msg.id));
        })
      ), 'newSeedSession');


      addSubToMaster(activePlayer$.pipe(
        changeOfType('added'),
        withLatestFrom(activeSeedSessionSubject),
        mergeMap(async ([player, session]) => {
          if (!session) return;
          // const playersLeft = active
          const playersLeft = server.seed_success_player_count - activePlayers.size;
          let msgOptions = playerJoinedSession(player.name, playersLeft);
          const msg = await sendManagedMessage(msgOptions, ServerMessageRole.PlayerJoined);
          generatedMessages.add(BigInt(msg.id));
        })
      ), 'addedSeedSession');

      addSubToMaster(seedSession$.pipe(
        changeOfType('removed')
      ), 'removedSeedSessions', {
        next: async () => {
          await Promise.all([...generatedMessages.values()].map(async id => {
            await removeManagedMessage(id);
            generatedMessages.delete(id);
          }));
        }
      });
    })();

    const notifiedSeeder$ = (function notifyAvailableSeeders(): Observable<Seeder> {
      const deferredGuild = Promise.all([discordClientDeferred, tenantDeferred]).then(([client, tenant]) => client.guilds.fetch(tenant.guild_id.toString()));

      return activeSeedSessionSubject.pipe(
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
    addSubToMaster(notifiedSeeder$, 'notifiedSeeder');


    (function trackNonResponsiveSeeders() {
      const nonResponsive$ = notifiedSeeder$.pipe(
        mergeMap((seeder) => {
          return timer(server.seeder_max_response_time).toPromise().then(() => seeder);
        })
      );
      addSubToMaster(nonResponsive$, 'nonResponsiveSeeders', notAttendingSeederSubject);
    })();
  })();


  return {
    serverSeedSignupAttempt$: seedSignupAttempt$
  };
}
