import { sql } from '@databases/pg';
import { DiscordAPIError } from '@discordjs/rest';
import { Mutex } from 'async-mutex';
import minutesToMilliseconds from 'date-fns/minutesToMilliseconds';
import discord, {
  Message,
  MessageEditOptions,
  MessageOptions,
  TextChannel
} from 'discord.js';
import deepEquals from 'lodash/isEqual';
import {
  BehaviorSubject,
  combineLatest,
  EMPTY,
  concat,
  from,
  interval, merge,
  asyncScheduler,
  Observable,
  of,
  Subject,
  timer
} from 'rxjs';
import {
  concatMap,
  distinctUntilChanged,
  filter,
  first,
  map,
  mapTo,
  mergeAll,
  mergeMap,
  share,
  startWith,
  tap,
  withLatestFrom
} from 'rxjs/operators';
import { setTimeout } from 'timers/promises';
import {
  Player,
  Seeder,
  SeedSessionLog,
  Server
} from './__generated__';
import {
  createObserverTarget,
  registerInputObservable
} from './cleanup';
import { config } from './config';
import { dbPool, schema } from './db';
import { discordClientDeferred } from './discordClient';
import { commandNames } from './discordCommands';
import {
  editServerSeedMessageMapName,
  editServerSeedMessagePlayerCount,
  playerJoinedSession,
  seedSessionStart,
  serverSeedMessage, signUpPromptMessage
} from './discordComponents';
import { logger, ppObj } from './globalServices/logger';
import { getInstanceGuild, instanceTenantDeferred } from './instanceTenant';
import {
  accumulateMap,
  catchErrorsOfClass,
  Change,
  changeOfType, flattenDeferred, getElt,
  mapChange,
  scanChangesToMap, toChange,
  trackUnifiedState
} from './lib/asyncUtils';
import {
  getChatCommandInteraction,
  InteractionError,
  observeMessageReactions
} from './lib/discordUtils';
import {
  createEntityStore,
  EntityStore,
  processAllEntities, IndexCollection
} from './lib/entityStore';
import { Future } from './lib/future';
import {
  observeOn,
  shareReplay,
  takeUntil,
  takeWhile
} from './lib/rxOperators';
import { parseTimespan, TimespanParsingError } from './lib/timespan';
import { enumRepr, isNonNulled } from './lib/typeUtils';
import {
  MessageWithRole,
  PlayerWithDetails,
  SeedSessionEndReason,
  SeedSessionEvent,
  SeedSessionEventType,
  ServerMessageRole,
  ServerWithDetails,
  SessionStartCommandOptions
} from './models';
import {
  notifiableSeedersStoreDeferred,
  seederStoreDeferred
} from './setupSeeders';
import { observeSquadServer, queryGameServer } from './squadServer';


const serverIndexes = {
  id: (server: ServerWithDetails) => server.id
};

export type ServerEntityStore = EntityStore<'id', number, ServerWithDetails>;
const _serversDeferred = new Future<ServerEntityStore>();
export const serverStoreDeferred = _serversDeferred as Promise<ServerEntityStore>;

const activeSeedSessionIndexes = {
  id: (session: SeedSessionLog) => session.id,
  serverId: (session: SeedSessionLog) => session.server_id
};

type SeedSessionEntityStore = EntityStore<keyof (typeof activeSeedSessionIndexes), number, SeedSessionLog>;
const _activeSeedSessionsDeferred = new Future<SeedSessionEntityStore>();
export const activeSeedSessionsDeferred = _activeSeedSessionsDeferred as Promise<SeedSessionEntityStore>;

// // serverId is bigint so it'll work with MultiIndexing
export type SignUpReaction = { discordUserId: bigint; serverId: number };
//
const signUpIndexes = {
  discordUserId: (r: SignUpReaction) => r.discordUserId,
  serverId: (r: SignUpReaction) => BigInt(r.serverId)
};
type SignUpEntityStore = EntityStore<keyof (typeof signUpIndexes), bigint, SignUpReaction>;
// attempts which d

const _signUpReactions = new Future<SignUpEntityStore>();
export const signUpReactions = _signUpReactions as Promise<SignUpEntityStore>;


export async function setupServers() {
  const servers = await (async function initServerState() {
    const instanceTenant = await instanceTenantDeferred;
    const serversInDb = await schema.server(dbPool).select({ tenant_id: instanceTenant.id }).all();
    for (let configured of config.servers) {
      await schema.server(dbPool).insertOrUpdate(['id'], {
        ...configured,
        tenant_id: instanceTenant.id,
        player_threshold_coefficient: config.player_threshold_coefficient,
        seeder_threshold_coefficient: config.seeder_threshold_coefficient,
        seed_start_threshold: config.seed_start_threshold,
        seed_failed_threshold: config.seed_failed_threshold,
        seed_success_player_count: config.seed_success_player_count,
        seeder_max_response_time: parseTimespan(config.seeder_max_response_time)
      });
    }
    for (let s of serversInDb) {
      if (!config.servers.map(s => s.id).includes(s.id)) {
        await schema.server(dbPool).delete({ id: s.id });
      }
    }
    return schema.server(dbPool).select({}).all();
  })();


  let mergedServerChange$: Observable<Change<ServerWithDetails>> = EMPTY;
  let mergedSignup$: Observable<Change<SignUpReaction>> = EMPTY;
  let mergedSeedSession$: Observable<Change<SeedSessionLog>> = EMPTY;
  for (let server of servers) {
    const {
      serverSeedSignupChange$,
      gameServerChange$,
      seedSession$
    } = setupServer(server);

    mergedSignup$ = merge(mergedSignup$, serverSeedSignupChange$);
    mergedServerChange$ = merge(mergedServerChange$, gameServerChange$);
    mergedSeedSession$ = merge(mergedSeedSession$, seedSession$);
  }

  _serversDeferred.resolve(createEntityStore(mergedServerChange$, serverIndexes));
  _activeSeedSessionsDeferred.resolve(createEntityStore(mergedSeedSession$, activeSeedSessionIndexes as IndexCollection<keyof typeof activeSeedSessionIndexes, number, SeedSessionLog>));
  _signUpReactions.resolve(createEntityStore(mergedSignup$, signUpIndexes));

  // manage completeion of seed sessions
  createObserverTarget(from(mergedSeedSession$.toPromise().finally(async () => {
    const hangingSessions = [...(await activeSeedSessionsDeferred).state.id.values()];
    for (let session of hangingSessions) {
      await schema.seed_session_log(dbPool).update({ id: session.id }, {
        end_reason: SeedSessionEndReason.Cancelled,
        end_time: new Date()
      });
      logger.warn(`cancelled remaining active seed session ${session.id} due to unforseen error`, { session });
    }
  })), { context: 'ManageCompletionOfSeedSessions' });
}


export function setupServer(server: Server) {
  const deferredChannel: Promise<TextChannel> = (async () => {
    const channel = await (await discordClientDeferred).channels.fetch(config.seeding_channel_id);
    if (channel === null) {
      throw new Error(`seed channel for server ${server.host}:${server.query_port} does not exist`);
    }
    return channel as discord.TextChannel;
  })();


  // fetch game server updates on an interval
  const gameServerUpdate$: Observable<Change<ServerWithDetails>> = (function observeGameServerUpdates() {
    const getServerWithDetails = () => queryGameServer(server.host, server.query_port).then(details => ({ ...server, ...details }) as ServerWithDetails);
    const pollGameServerUpdate$: Observable<ServerWithDetails> = interval(minutesToMilliseconds(1)).pipe(
      registerInputObservable({ context: 'pollGameServerUpdate' }),
      mergeMap(getServerWithDetails),
      distinctUntilChanged(deepEquals)
    );

    return concat(
      getServerWithDetails().then(toChange('added')),
      pollGameServerUpdate$.pipe(map(toChange('updated')))
    ).pipe(shareReplay(1));
  })();
  gameServerUpdate$.subscribe((update) => {
    logger.info('game server update: ', update);
  });

  function getGameServerDetails() {
    return gameServerUpdate$.pipe(first(), map(getElt)).toPromise() as Promise<ServerWithDetails>;
  }

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
              await schema.player(dbPool).insertOrUpdate(['steam_id'], { steam_id: steamId });
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
    createObserverTarget(o, { context: 'trackAndPersistActivePlayers' });
    return o;
  })();
  const activePlayers = new Map<bigint, PlayerWithDetails>();
  createObserverTarget(activePlayer$, { context: 'accumulateActivePlayers' }, { next: accumulateMap(activePlayers, player => player.steam_id) });
  createObserverTarget(activePlayer$, { context: 'countActivePlayers' }, { next: () => logger.info(`num active players: ${activePlayers.size}`) });

  const {
    serverMessagesDeferred,
    sendManagedMessage,
    removeManagedMessage,
    editManagedMessage
  } = (function manageChannelMessages() {
    const messageMutexesDeferred = new Future<Map<bigint, Mutex>>();
    const serverMessagesDeferred: Future<Map<bigint, MessageWithRole>> = new Future();

    // TODO: better error handling for when message is deleted externally

    async function sendManagedMessage(options: MessageOptions | string, role: ServerMessageRole) {
      const channel = await deferredChannel;
      const msg = await channel.send(options);
      let messageId = BigInt(msg.id);
      await schema.server_managed_message(dbPool).insert({
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
        throw new Error('trying to edit message that is not tracked or does not exist');
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
        await schema.server_managed_message(dbPool).delete({
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
      let channelId = BigInt((await deferredChannel).id);
      const rows = await schema.server_managed_message(dbPool).select({
        server_id: server.id,
        channel_id: channelId
      }).all();

      const channel = await deferredChannel;
      const messages = (await Promise.all(rows.map(async (row): Promise<MessageWithRole | null> => {
        try {
          let msg = await channel.messages.fetch(row.message_id.toString());
          return ({
            msg: msg,
            role: row.role
          });
        } catch (err) {
          if (err instanceof DiscordAPIError && err.code === 10008) {
            await schema.server_managed_message(dbPool).delete(row);
            return null;
          }
          throw err;
        }
      }))).filter(isNonNulled);
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

    const gameServerState = await gameServerUpdate$.pipe(first(), map(getElt)).toPromise();
    const builtMessage = serverSeedMessage(gameServerState!.name, activePlayers.size);
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

  const seedSignUpChange$: Observable<Change<SignUpReaction>> = (function observeSignupAttempts() {
    return messageReaction$.pipe(
      mapChange((reaction): SignUpReaction => {
        return {
          serverId: server.id,
          discordUserId: BigInt(reaction.userId)
        };
      })
    );
  })();


  // manage and record seeding sessions
  let seedSession$: Observable<Change<SeedSessionLog>>;
  (function setupSeeding() {
    const serverSeeder$ = seedSignUpChange$.pipe(
      changeOfType('added'),
      mergeMap(async (reactionAdded) => {
        let seederStore = await seederStoreDeferred;
        const seeder = seederStore.state.discordId.get(reactionAdded.discordUserId);
        if (!seeder) {
          const [{ count }] = (await dbPool.query(sql`SELECT COUNT(*)
                                                      FROM users_prompted_for_signup
                                                      WHERE discord_id ? ${reactionAdded.discordUserId}`)) as [{ count: bigint }];
          if (count !== 0n) return null;
          const guildMember = await (await getInstanceGuild()).members.fetch(reactionAdded.discordUserId.toString());
          guildMember.send(signUpPromptMessage(guildMember, 'https://discord.com/channels/465971449954304000/1011993778787201125/1015395461374410812'));
        }

        const reactionRemoved = seedSignUpChange$.pipe(
          changeOfType('removed'),
          filter(reaction => reaction.discordUserId === reactionAdded.discordUserId),
          first()
        ).toPromise();


        const seederChanges = processAllEntities(seederStore)
          .pipe(
            filter(seederChange => seederChange.elt.discord_id === reactionAdded.discordUserId),

            // keep listening until the reaction was removed or the seeder leaves
            takeWhile(change => change.type !== 'removed'),
            takeUntil(reactionRemoved)
          );
        return seederChanges;

      }),
      filter(isNonNulled)
    );


    // const serverSeeder$: Observable<Change<Seeder>> = ((() => {
    //   // listen for seeder reactions and track on the database
    //   // let  = getFirstAfterDeferred(deferredServerMessage$);
    //
    //
    //   return messageReaction$.pipe(
    //     withLatestFrom(mainServerMessageDeferred, seederStoreDeferred),
    //     mergeMap(async ([reactionChange, serverMessage, seeders]): Promise<Change<Seeder> | undefined> => {
    //       const { reaction, userId } = reactionChange.elt;
    //       if (reaction.message.id !== serverMessage.id) throw new Error('unable to locate server reaction message');
    //       const seeder = seeders.state.discordId.get(BigInt(userId));
    //       if (!seeder) return;
    //       switch (reactionChange.type) {
    //         case 'added': {
    //           await schema.server_seeder(dbPool).insert({
    //             server_id: server.id,
    //             seeder_id: seeder.id
    //           });
    //           return {
    //             elt: seeder,
    //             type: 'added'
    //           } as Change<Seeder>;
    //         }
    //         case 'removed': {
    //           await schema.server_seeder(dbPool).delete({
    //             server_id: server.id,
    //             seeder_id: seeder.id
    //           });
    //           return {
    //             elt: seeder,
    //             type: 'removed'
    //           };
    //         }
    //         case 'updated': {
    //           return {
    //             elt: seeder,
    //             type: 'updated'
    //           };
    //         }
    //       }
    //       return;
    //     }),
    //     filter(isNonNulled)
    //   );
    // })());


    const notifiableServerSeeder$: Observable<Change<Seeder>> = (function observeNotifiableServerSeeders() {
      return from([
        serverSeeder$,
        processAllEntities(notifiableSeedersStoreDeferred),
        activePlayer$
      ] as Observable<Change<Seeder>>[]).pipe(
        map(mapChange(elt => elt.steam_id)),
        // ensure
        trackUnifiedState([true, true, false]),
        withLatestFrom(seederStoreDeferred),
        map(([change, seeders]) => {
          const seeder = seeders.state.steamId.get(change.elt) as Seeder;
          return {
            type: change.type,
            elt: seeder
          };
        })
      );
    })();

    // pretty please only push values to this inside of trackAndPersistSeedSessions
    const activeSeedSessionSubject = new BehaviorSubject<SeedSessionLog | null>(null);

    const notAttendingSeederSubject = new Subject<Seeder>();
    (function trackAndPersistSeedSessions() {
      const notAttendingChange$ = notAttendingSeederSubject.pipe(
        map(seeder => ({
          type: 'removed',
          elt: seeder
        } as Change<Seeder>)));

      const possiblyAttendingSeeder$ = of(notifiableServerSeeder$, notAttendingChange$).pipe(mergeAll());

      const chatCommandInteraction$ = flattenDeferred(discordClientDeferred.then(c => getChatCommandInteraction(c)));

      let activeSessionId$ = activeSeedSessionSubject.pipe(map(session => session?.id || null));
      const invokedStartSession$: Observable<SessionStartCommandOptions> = (function listenForStartSessionCommand() {
        return chatCommandInteraction$.pipe(
          withLatestFrom(activeSessionId$),
          map(([interaction, activeSessionId]): SessionStartCommandOptions | null => {
            if (interaction.commandName !== commandNames.startSeedingSession.name) return null;
            const serverId = Number(interaction.options.getString(commandNames.startSeedingSession.options.server));
            if (server.id !== serverId) return null;
            const options: Partial<SessionStartCommandOptions> = {};

            if (activeSessionId) throw new InteractionError('Already in active session!', interaction);

            let gracePeriod = interaction.options.getString(commandNames.startSeedingSession.options.gracePeriod);
            gracePeriod ||= config.default_grace_period;
            try {
              const gracePeriodSpan = parseTimespan(gracePeriod);
              options.gracePeriod = gracePeriodSpan;
            } catch (error: any) {
              if (!(error instanceof TimespanParsingError)) {
                throw error;
              }
              throw new InteractionError(`Unable to parse given grace period (${gracePeriod})`, interaction);
            }

            const failureImpossible = interaction.options.getBoolean(commandNames.startSeedingSession.options.failureImpossible);
            if (failureImpossible === null) {
              options.failureImpossible = false;
            } else {
              options.failureImpossible = failureImpossible;
            }

            interaction.reply({
              content: 'Starting new session',
              ephemeral: true
            });
            logger.info('starting new session: ', options);
            return options as SessionStartCommandOptions;
          }),
          filter(isNonNulled),
          catchErrorsOfClass(InteractionError),
          share()
        );
      })();

      const invokedEndSession$ = new Observable<void>();

      const inGracePeriod$ = invokedStartSession$.pipe(
        map(options => options.gracePeriod || null),
        filter(isNonNulled),
        concatMap(gracePeriod => from(setTimeout(gracePeriod)).pipe(mapTo(false), startWith(true))),
        startWith(false)
      );

      let activeSessionOptions: SessionStartCommandOptions | null = null;

      // locked while inserting session log on the database
      const activeSessionMtx = new Mutex();

      const generatedSeedSessionEvent$: Observable<SeedSessionEvent> = combineLatest([
        activePlayer$.pipe(scanChangesToMap(elt => elt.steam_id)),
        possiblyAttendingSeeder$.pipe(scanChangesToMap(elt => elt.steam_id)),
        inGracePeriod$,
        activeSessionId$
      ]).pipe(
        observeOn(asyncScheduler),
        map(([players, seeders, inGracePeriod, activeSessionId]) => {
          // if the mutex is locked, that means we'll get a different activeSessionId to use instead soon
          if (inGracePeriod || activeSessionMtx.isLocked()) return null;
          return checkForAutomaticSessionChange(server, players, seeders, !!activeSessionId);
        }),
        filter(isNonNulled)
      );


      const seedSessionEvent$: Observable<SeedSessionEvent> = of(
        generatedSeedSessionEvent$,
        invokedStartSession$.pipe(map(options => ({
          type: SeedSessionEventType.Started,
          options
        } as SeedSessionEvent))),
        invokedEndSession$.pipe(mapTo({ type: SeedSessionEventType.Cancelled } as SeedSessionEvent))
      ).pipe(mergeAll(),
        // filter out failure events when options.failureImpossible is set
        filter((event) => !(event.type === SeedSessionEventType.Failure && activeSessionOptions?.failureImpossible)),
        tap((event) => {
          logger.info(`posted new session event: ${ppObj({ type: enumRepr(SeedSessionEventType, event.type) })}`, event);
        }),
        share()
      );


      const persistedChange$ = seedSessionEvent$.pipe(
        withLatestFrom(activeSessionId$),
        concatMap(async ([event, activeSessionId]) => {
          await activeSessionMtx.acquire();
          let change: Change<SeedSessionLog>;
          try {
            switch (event.type) {
              case SeedSessionEventType.Started: {
                if (activeSessionId) throw new Error(`activeSessionId already set when success SeedSessionEvent sent: ${activeSessionId}`);
                const [row] = await schema.seed_session_log(dbPool).insert({
                  server_id: server.id,
                  start_time: new Date(),
                  failure_impossible: event.options.failureImpossible,
                  grace_period: event.options.gracePeriod
                });
                activeSessionId = row.id;
                change = {
                  elt: row,
                  type: 'added'
                };
                break;
              }
              case SeedSessionEventType.Success: {
                if (!activeSeedSessionSubject) throw new Error(`activeSessionId not set when success SeedSessionEvent sent`);
                const [row] = await schema.seed_session_log(dbPool).update({ id: activeSessionId as number }, {
                  end_time: new Date(),
                  end_reason: SeedSessionEndReason.Success
                });
                activeSessionId = null;
                change = {
                  elt: row,
                  type: 'removed'
                };
                break;
              }
              case SeedSessionEventType.Failure: {
                if (!activeSessionId) throw new Error(`activeSessionId already set when failure SeedSessionEvent sent`);
                const [row] = await schema.seed_session_log(dbPool).update({ id: activeSessionId as number }, {
                  end_time: new Date(),
                  end_reason: SeedSessionEndReason.Failure
                });
                activeSessionId = null;
                change = {
                  elt: row,
                  type: 'removed'
                };
                break;
              }
              case SeedSessionEventType.Cancelled: {
                if (!activeSessionId) throw new Error(`activeSessionId already set when abort SeedSessionEvent sent`);
                const [row] = await schema.seed_session_log(dbPool).update({ id: activeSessionId as number }, {
                  end_time: new Date(),
                  end_reason: SeedSessionEndReason.Cancelled
                });
                activeSessionId = null;
                change = {
                  elt: row,
                  type: 'removed'
                };
                break;
              }
            }
          } catch (err) {
            throw err;
          } finally {
            activeSessionMtx.release();
          }
          return change;
        }),
        tap(change => logger.info(ppObj(change))),
        share()
      );
      createObserverTarget(persistedChange$, { context: 'persistedSeedSessionChange' });

      persistedChange$.pipe(
        filter(change => change.type !== 'updated'),
        map(change => change.type === 'added' ? change.elt : null)
      ).subscribe(activeSeedSessionSubject);

      seedSession$ = persistedChange$;
    })();


    (function updateDisplayedServerDetails() {
      const msgMutex: Mutex = new Mutex();

      (function updateDisplayedMapName() {
        createObserverTarget(gameServerUpdate$.pipe(changeOfType('updated')), { context: 'updateDisplayedMapName' }, {
          next: (gameServer) =>
            msgMutex.runExclusive(async () => {
              const msg = await mainServerMessageDeferred;
              const options = editServerSeedMessageMapName(msg, gameServer.map);
              options && editManagedMessage(BigInt(msg.id), options);
            })
        });
      })();

      (function updateDisplayedPlayerCount() {
        createObserverTarget(activePlayer$, { context: 'updateDisplayedPlayerCount' }, {
          next: () =>
            msgMutex.runExclusive(async () => {
              const msg = await mainServerMessageDeferred;
              await editManagedMessage(BigInt(msg.id), editServerSeedMessagePlayerCount(msg, activePlayers.size));
            })
        });
      })();
    })();


    (function manageSeedSessionMessages() {
      const sessionLifecycleMessageSaga$ = seedSession$.pipe(
        changeOfType('added'),
        mergeMap(async function manageMessagesForSession(startedSession) {
          const onEnded = seedSession$.pipe(changeOfType('removed'), filter(log => log.id === startedSession.id), first()).toPromise();
          const generatedMessages = new Set<bigint>();

          await (async function sendStartSessionMessage() {
            const serverDetails = await getGameServerDetails();
            let options = seedSessionStart(serverDetails.name, activePlayers.size, server.seed_success_player_count, startedSession.start_time);
            const msg = await sendManagedMessage(options, ServerMessageRole.SessionStart);
            generatedMessages.add(BigInt(msg.id));
          })();


          await (function sendPlayerJoinedMessagesUntilSessionEnded() {
            return activePlayer$.pipe(
              changeOfType('added'),
              takeUntil(onEnded),
              mergeMap(async (player) => {
                const playersLeft = server.seed_success_player_count - activePlayers.size;
                let msgOptions = playerJoinedSession(player.name, playersLeft);
                const msg = await sendManagedMessage(msgOptions, ServerMessageRole.PlayerJoined);
                generatedMessages.add(BigInt(msg.id));
              })
            ).toPromise();
          })();

          const removedSession = await onEnded;
          await (async function sendEndingMessage() {
            let serverName = (await getGameServerDetails()).name;
            let msg: Message;
            switch (removedSession!.end_reason as number) {
              case SeedSessionEndReason.Failure: {
                msg = await sendManagedMessage(`Seeding ${serverName} failed. Better luck next time!`, ServerMessageRole.SessionEnded);
                break;
              }
              case SeedSessionEndReason.Cancelled: {
                msg = await sendManagedMessage(`Seeding ${serverName} was cancelled.`, ServerMessageRole.SessionEnded);
                break;
              }
              case SeedSessionEndReason.Success: {
                msg = await sendManagedMessage(`Seeding ${serverName} Succeeded! Yay!`, ServerMessageRole.SessionEnded);
                break;
              }
              default: {
                throw new Error('unhandled seedsession end reason ' + enumRepr(SeedSessionEndReason, removedSession!.end_reason as number));
              }
            }
            generatedMessages.add(BigInt(msg.id));
          })();

          await (async function deleteGeneratedMessages() {
            if (config.debug?.delete_stale_messages === false) return;
            await setTimeout(minutesToMilliseconds(1));
            await Promise.all([...generatedMessages.values()].map(async id => {
              await removeManagedMessage(id);
            }));
          })();
        })
      );
      createObserverTarget(sessionLifecycleMessageSaga$, { context: 'sessionLifecycleMessageSaga$' });
    })();

    const notifiedSeeder$ = (function notifyAvailableSeeders(): Observable<Seeder> {

      return seedSession$.pipe(
        changeOfType('added'),
        withLatestFrom(notifiableServerSeeder$.pipe(scanChangesToMap(seeder => seeder.discord_id))),
        mergeMap(async ([addedSession, seeders]) => {
          const serverName = (await getGameServerDetails()).name;
          const sent = [...seeders.values()].map(seeder => getInstanceGuild()
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
    createObserverTarget(notifiedSeeder$, { context: 'notifiedSeeder' });


    (function trackNonResponsiveSeeders() {
      const nonResponsive$ = notifiedSeeder$.pipe(
        mergeMap((seeder) => {
          // wait for the seeder to join the server for a set amount of time
          const joined$ = activePlayer$.pipe(changeOfType('added'), filter(change => change.steam_id === seeder.steam_id), first());
          const timedOut$ = timer(server.seeder_max_response_time).pipe(registerInputObservable({ context: 'waitForSeederTimeOut' }));

          // race joined$ and timedOut$
          return of(joined$, timedOut$).pipe(mergeAll(), first(), mapTo(seeder));
        })
      );

      nonResponsive$.subscribe(notAttendingSeederSubject);
    })();
  })();


  return {
    gameServerChange$: gameServerUpdate$,
    serverSeedSignupChange$: seedSignUpChange$,
    seedSession$: seedSession$
  };
}

/**
 * check to see if we should emit a change event automatically based on given inputs
 * returning null means no change
 */
function checkForAutomaticSessionChange(server: Server, playersInServer: Map<bigint, Player>, seederPool: Map<bigint, Seeder>, inActiveSession: boolean): SeedSessionEvent | null {
  const uniquePlayers = new Set([...playersInServer.keys(), ...seederPool.keys()]);

  const adjustedPlayerCount = server.player_threshold_coefficient * playersInServer.size;
  const adjustedSeederCount = server.seeder_threshold_coefficient * seederPool.size;
  const adjustedCounts = adjustedSeederCount + adjustedPlayerCount;

  const inStartThreshold = server.seed_start_threshold <= adjustedCounts;
  const inFailedThreshold = server.seed_failed_threshold >= adjustedCounts;
  const hasSuccessPlayerCount = uniquePlayers.size >= server.seed_success_player_count;
  if (!inActiveSession && inStartThreshold) return {
    type: SeedSessionEventType.Started,
    options: { failureImpossible: false }
  };
  const data = ({
    uniquePlayers: uniquePlayers.size,
    activePlayers: playersInServer.size,
    activeSeeders: seederPool.size,
    adjustedPlayerCount,
    adjustedSeederCount,
    combinedCounts: adjustedCounts,
    startThresholdDiff: server.seed_start_threshold - adjustedCounts,
    failedThresholdDiff: server.seed_failed_threshold - adjustedCounts,
    successDiff: server.seed_success_player_count - uniquePlayers.size
  });
  logger.info(`Tested for automatic session change: ${ppObj(data)}`);


  if (inActiveSession && inFailedThreshold) return { type: SeedSessionEventType.Failure };
  if (inActiveSession && hasSuccessPlayerCount) return { type: SeedSessionEventType.Success };


  return null;
}
