import { DiscordAPIError } from '@discordjs/rest';
import { Player, Seeder, SeedSessionLog, Server } from '__generated__';
import { Mutex } from 'async-mutex';
import minutesToMilliseconds from 'date-fns/minutesToMilliseconds';
import secondsToMilliseconds from 'date-fns/secondsToMilliseconds';
import discord, {
  Message,
  MessageEditOptions,
  MessageOptions,
  TextChannel
} from 'discord.js';
import {
  catchErrorsOfClass,
  Change,
  changeOfType,
  countEntities,
  flattenDeferred,
  getElt,
  mapChange,
  scanChangesToMap,
  toChange,
  trackUnifiedState
} from 'lib/asyncUtils';
import {
  getChatCommandInteraction,
  InteractionError,
  observeMessageReactions
} from 'lib/discordUtils';
import { EntityStore, IndexCollection } from 'lib/entityStore';
import { Future } from 'lib/future';
import { observeOn, shareReplay, takeUntil } from 'lib/rxOperators';
import { parseTimespan, TimespanParsingError } from 'lib/timespan';
import { enumRepr, isNonNulled } from 'lib/typeUtils';
import deepEquals from 'lodash/isEqual';
import {
  asyncScheduler,
  BehaviorSubject,
  combineLatest,
  concat,
  EMPTY,
  firstValueFrom,
  from,
  interval,
  lastValueFrom,
  merge,
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
import { baseLogger, ppObj } from 'services/baseLogger';
import { config } from 'services/config';
import { dbPool, schema } from 'services/db';
import { setTimeout } from 'timers/promises';
import {
  playerJoinedSession,
  seedSessionStart,
  serverSeedMessage
} from 'views/discordComponents';
import { createObserverTarget, registerInputObservable } from '../../cleanup';
import { RawPlayer } from '../../services/config/Config';
import { discordClientDeferred } from '../discordClientSystem';
import { commandNames } from '../discordCommandsSystem';
import {
  getInstanceGuild,
  instanceTenantDeferred
} from '../instanceTenantSystem';
import {
  filterNonSeederReactions,
  notifiableSeedersStoreDeferred,
  seederStoreDeferred
} from '../seederSystem';
import {
  observePlayerChangesFromSquadJS,
  queryGameServer
} from './squadServer';


//region Types
export type PlayerWithDetails = Player & Omit<RawPlayer, 'steamID' | 'playerID'>

export enum NotifyWhen {
  Online,
  Playing,
  Always,
  Never,
  PlayingSquad
}

export enum SeedSessionEndReason {
  Success = 0,
  Failure = 1,
  Cancelled = 2
}

export enum SeedSessionEventType {
  Success = 0,
  Failure = 1,
  Cancelled = 2,
  Started = 3,
}

export enum SeedLogEndReason {
  Success = 0,
  Failure = 1,
  Cancelled = 2,
  Disconnected = 3,
}

export type SessionStartCommandOptions = {
  gracePeriod?: number;
  failureImpossible: boolean;
}
export type SeedSessionEvent =
  | { type: SeedSessionEventType.Started; options: SessionStartCommandOptions }
  | { type: SeedSessionEventType.Success; }
  | { type: SeedSessionEventType.Failure; }
  | { type: SeedSessionEventType.Cancelled; }

export enum ServerMessageRole {
  Main,
  SessionStart,
  PlayerJoined,
  SessionEnded,
}

export type MessageWithRole = { msg: Message; role: ServerMessageRole };
export type ServerDetails = { name: string; map: string; maxplayers: number; }
export type ServerWithDetails = Server & ServerDetails;

//endregion


//region Exported State
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

export type SignUpReaction = { discordUserId: bigint; serverId: number };
const signUpIndexes = {
  discordUserId: (r: SignUpReaction) => r.discordUserId,
  serverId: (r: SignUpReaction) => BigInt(r.serverId)
};
type SignUpEntityStore = EntityStore<keyof (typeof signUpIndexes), bigint, SignUpReaction>;
const _signUpReactions = new Future<SignUpEntityStore>();
export const signUpReactions = _signUpReactions as Promise<SignUpEntityStore>;

//endregion


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

  _serversDeferred.resolve(new EntityStore(mergedServerChange$, serverIndexes, 'servers'));

  _activeSeedSessionsDeferred.resolve(new EntityStore(
    mergedSeedSession$,
    activeSeedSessionIndexes as IndexCollection<keyof typeof activeSeedSessionIndexes, number,
      SeedSessionLog>,
    'activeSeedSessions'
  ).setPrimaryIndex('id'));

  _signUpReactions.resolve(new EntityStore(mergedSignup$, signUpIndexes, 'signUpReactions').setPrimaryIndex('serverId'));
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
    baseLogger.info('game server update: ', ppObj(update));
  });

  function getGameServerDetails() {
    return gameServerUpdate$.pipe(first(), map(getElt)).toPromise() as Promise<ServerWithDetails>;
  }

  const activePlayerStore = (function trackAndPersistActivePlayers() {
    const playerMtx = new Mutex();
    const activePlayer$ = observePlayerChangesFromSquadJS(server).pipe(
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
      tap(change => baseLogger.info(`${change.type} ${change.elt.name} (${change.elt.steam_id})`, change)),
      share()
    );
    createObserverTarget(activePlayer$, { context: 'trackAndPersistActivePlayers' });
    const activePlayerStore = new EntityStore(
      activePlayer$,
      { steam_id: elt => elt.steam_id },
      'activePlayerStore'
    ).setPrimaryIndex('steam_id');
    return activePlayerStore;
  })();

  createObserverTarget(activePlayerStore.trackSize(), { context: 'countActivePlayers' }, { next: count => baseLogger.info(`num active players: ${count}`) });

  const messageManagerDeferred = (async () => new ServerMessageManager(server, await deferredChannel).setup())();

  const messageReaction$ = flattenDeferred(
    Promise.all([discordClientDeferred, messageManagerDeferred.then(m => m.mainServerMessageDeferred)])
      .then(([client, msg]) => observeMessageReactions(client, msg))
  );

  const seedSignUpChange$: Observable<Change<SignUpReaction>> = (function observeSignupAttempts() {
    return messageReaction$.pipe(
      filterNonSeederReactions(),
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
  let notifiableServerSeeder$: Observable<Change<Seeder>>;
  (function manageSeedSessions() {
    const serverSeeder$ = seedSignUpChange$.pipe(
      changeOfType('added'),
      mergeMap(async (reactionAdded) => {

        let seederStore = await seederStoreDeferred;
        let discordUserId = reactionAdded.discordUserId;
        const seeder = seederStore.state.discordId.get(discordUserId);
        if (!seeder) {
        }
        const reactionRemoved = seedSignUpChange$.pipe(
          changeOfType('removed'),
          filter(reaction => reaction.discordUserId === discordUserId),
          first()
        ).toPromise();

        const seederChanges = seederStore
          .trackEntity(discordUserId, 'discordId', false)
          .pipe(takeUntil(reactionRemoved));

        return seederChanges;

      }),
      filter(isNonNulled),
      mergeAll()
    );


    notifiableServerSeeder$ = (function observeNotifiableServerSeeders() {
      return from([
        serverSeeder$,
        flattenDeferred(notifiableSeedersStoreDeferred.then(s => s.trackAllEntities())),
        activePlayerStore.change$
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
            baseLogger.info('starting new session: ', options);
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
        activePlayerStore.change$.pipe(scanChangesToMap(elt => elt.steam_id)),
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


      let seedSessionEvent$: Observable<SeedSessionEvent> = of(
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
          baseLogger.info(`posted new session event: ${ppObj({ type: enumRepr(SeedSessionEventType, event.type) })}`, event);
        }),
        share()
      );

      seedSessionEvent$ = concat(
        seedSessionEvent$,
        // if we run out of events to send and there's still an active session, then send a cancellation event
        lastValueFrom(seedSessionEvent$).then(() => {
          if (activeSeedSessionSubject.value) {
            baseLogger.info('seedSessionEvent completed, cancelling active session');
            return { type: SeedSessionEventType.Cancelled } as SeedSessionEvent;
          } else {
            return null;
          }
        })
      ).pipe(filter(isNonNulled));


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
        tap(change => baseLogger.info(ppObj(change))),
        share()
      );
      createObserverTarget(persistedChange$, { context: 'persistedSeedSessionChange' });

      persistedChange$.pipe(
        filter(change => change.type !== 'updated'),
        map(change => change.type === 'added' ? change.elt : null)
      ).subscribe(activeSeedSessionSubject);

      seedSession$ = persistedChange$;
    })();

    (function manageSeedSessionMessages() {
      const sessionLifecycleMessageSaga$ = seedSession$.pipe(
        changeOfType('added'),
        mergeMap(async function manageMessagesForSession(startedSession) {
          const onEnded = seedSession$.pipe(changeOfType('removed'), filter(log => log.id === startedSession.id), first()).toPromise();
          const generatedMessages = new Set<bigint>();
          const messageManager = await messageManagerDeferred;

          await (async function sendStartSessionMessage() {
            const serverDetails = await getGameServerDetails();
            let options = seedSessionStart(serverDetails.name, activePlayerStore.state.steam_id.size, server.seed_success_player_count, startedSession.start_time);
            const msg = await messageManager.sendMessage(options, ServerMessageRole.SessionStart);
            generatedMessages.add(BigInt(msg.id));
          })();


          await (function sendPlayerJoinedMessagesUntilSessionEnded() {
            return activePlayerStore.change$.pipe(
              changeOfType('added'),
              takeUntil(onEnded),
              mergeMap(async (player) => {
                const playersLeft = server.seed_success_player_count - activePlayerStore.state.steam_id.size;
                let msgOptions = playerJoinedSession(player.name, playersLeft);
                const msg = await messageManager.sendMessage(msgOptions, ServerMessageRole.PlayerJoined);
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
                msg = await messageManager.sendMessage(`Seeding ${serverName} failed. Better luck next time!`, ServerMessageRole.SessionEnded);
                break;
              }
              case SeedSessionEndReason.Cancelled: {
                msg = await messageManager.sendMessage(`Seeding ${serverName} was cancelled.`, ServerMessageRole.SessionEnded);
                break;
              }
              case SeedSessionEndReason.Success: {
                msg = await messageManager.sendMessage(`Seeding ${serverName} Succeeded! Yay!`, ServerMessageRole.SessionEnded);
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
              await messageManager.removeManagedMessage(id);
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

    (function logActivePlayersInSeedSession() {
      const logger = baseLogger.child({ context: 'logActivePlayersInSeedSession' });

      createObserverTarget(
        seedSession$.pipe(
          changeOfType('added'),
          mergeMap((session) => {
            const sessionEnded$ = firstValueFrom(seedSession$.pipe(filter(change => change.elt.id === session.id), changeOfType('removed')));
            return activePlayerStore.trackAllEntities()
              .pipe(
                takeUntil(sessionEnded$),
                changeOfType('added'),
                mergeMap(async (addedPlayer) => {
                  const addedLog = await schema.seed_log(dbPool).insert({
                    player_id: addedPlayer.steam_id,
                    start_time: new Date(),
                    seed_session_log_id: session.id
                  });
                  logger.info(`added seed log for player ${addedPlayer.steam_id}: `, { addedLog });
                  baseLogger.info('Opened seed log', { context: '' });
                  const endReason = await Promise.race([
                    activePlayerStore.trackEntityEvent(addedPlayer.steam_id, 'removed').then(() => SeedLogEndReason.Disconnected),
                    sessionEnded$.then(log => log.end_reason as SeedLogEndReason) // assert as SeedLogEndReason since the enums match up
                  ]);
                  const [updatedLog] = await schema.seed_log(dbPool).update({ player_id: addedPlayer.steam_id }, {
                    end_time: new Date(),
                    end_reason: endReason
                  });
                  logger.info(`finished seed log for player ${addedPlayer.steam_id}:  ${enumRepr(SeedLogEndReason, endReason)}) `, { updatedLog });
                })
              );
          })
        ),
        { context: 'logActivePlayersInSeedSession' }
      );
    })();

    (function trackNonResponsiveSeeders() {
      const nonResponsive$ = notifiedSeeder$.pipe(
        mergeMap((seeder) => {
          // wait for the seeder to join the server for a set amount of time
          const joined$ = activePlayerStore.trackAllEntities().pipe(changeOfType('added'), filter(change => change.steam_id === seeder.steam_id), first());
          const timedOut$ = timer(server.seeder_max_response_time).pipe(registerInputObservable({ context: 'waitForSeederTimeOut' }));

          // race joined$ and timedOut$
          return of(joined$, timedOut$).pipe(mergeAll(), first(), mapTo(seeder));
        })
      );

      nonResponsive$.subscribe(notAttendingSeederSubject);
    })();
  })();

  (async function manageMainServerMessage() {
    const updateCadence$ = interval(secondsToMilliseconds(5)).pipe(
      startWith(0),
      registerInputObservable({ context: 'serverMessageUpdateCadenceInterval' })
    );
    const serverDetails$ = gameServerUpdate$.pipe(
      filter(change => ['updated', 'added'].includes(change.type)),
      map(getElt)
    );
    const notifiableServerSeederCount$ = notifiableServerSeeder$.pipe(countEntities(elt => elt.discord_id));
    const messageManager = await messageManagerDeferred;

    const messageUpdate$ = updateCadence$.pipe(
      withLatestFrom(
        serverDetails$,
        notifiableServerSeederCount$
      ),
      map(([_, serverDetails, seederCount]) => {
        return [
          serverDetails.name,
          serverDetails.map,
          activePlayerStore.size,
          seederCount,
          serverDetails.player_threshold_coefficient,
          serverDetails.seeder_threshold_coefficient,
          serverDetails.seed_start_threshold
        ];
      }),

      // perform a react style "rerendering" of main message if the arguments to serverSeedMessage have changed
      distinctUntilChanged(deepEquals),
      mergeMap(async (props): Promise<Message> => {
        const options = serverSeedMessage(...(props as Parameters<typeof serverSeedMessage>));
        return messageManager.upsertMainMessage(options);
      }),

      share()
    );

    createObserverTarget(messageUpdate$, { context: 'messageUpdates' });
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
  baseLogger.debug(`Tested for automatic session change: ${ppObj(data)}`);


  if (inActiveSession && inFailedThreshold) return { type: SeedSessionEventType.Failure };
  if (inActiveSession && hasSuccessPlayerCount) return { type: SeedSessionEventType.Success };


  return null;
}

//region ServerMessageManager
type MessageEntityStore = EntityStore<'id', bigint, MessageWithRole>;
/**
 * Manage sent messages in the context of a server.
 * "managing" here means saving ids to db, ensuring we only edit against the newest version of the message, etc
 * TODO: if we need it, generalize this code so it can be used in other contexts
 */
class ServerMessageManager {
  private messageMutexesDeferred = new Future<Map<bigint, Mutex>>();
  private messageStoreDeferred = new Future<MessageEntityStore>();
  private messageChangeSubjectDeferred = new Future<Subject<Change<MessageWithRole>>>();
  private _mainServerMessageDeferred = new Future<Message>();
  public get mainServerMessageDeferred() {
    return this._mainServerMessageDeferred as Promise<Message>;
  }


  constructor(private server: Server, private channel: TextChannel) {
  }

  private async resolveMutex(messageId: bigint) {
    const mutex = (await this.messageMutexesDeferred).get(messageId);
    if (!mutex) {
      throw new Error(`message ${messageId} is not tracked`);
    }
    return mutex;
  }

  async sendMessage(options: MessageOptions | string, role: ServerMessageRole) {
    const msg = await this.channel.send(options);
    let messageId = BigInt(msg.id);
    await schema.server_managed_message(dbPool).insert({
      server_id: this.server.id,
      channel_id: BigInt(this.channel.id),
      message_id: messageId,
      role: role
    });
    (await this.messageMutexesDeferred).set(messageId, new Mutex());
    let messageWithRole = { msg, role };
    (await this.messageChangeSubjectDeferred).next({
      type: 'added',
      elt: messageWithRole
    });
    return msg;
  }

  async editManagedMessage(messageId: bigint, options: MessageEditOptions) {
    const mutex = await this.resolveMutex(messageId);
    await mutex.acquire();
    try {
      const msg = await this.channel.messages.fetch(messageId.toString());
      await msg.edit(options);
      let role = (await this.messageStoreDeferred).state.id.get(messageId)!.role;
      (await this.messageChangeSubjectDeferred).next({
        type: 'updated',
        elt: { role, msg }
      });
      return msg;
    } finally {
      mutex.release();
    }
  }

  async removeManagedMessage(messageId: bigint) {
    const mutex = await this.resolveMutex(messageId);
    await mutex.acquire();
    try {
      const msg = await this.channel.messages.fetch(messageId.toString());
      await msg.delete();
      await schema.server_managed_message(dbPool).delete({
        server_id: this.server.id,
        channel_id: BigInt(this.channel.id),
        message_id: messageId
      });
      const role = (await this.messageStoreDeferred).state.id.get(BigInt(msg.id))!.role;
      (await this.messageChangeSubjectDeferred).next({
        type: 'removed',
        elt: { msg, role }
      });
      return msg;
    } finally {
      mutex.release();
    }
  }

  async upsertMainMessage(options: MessageOptions) {
    const store = await this.messageStoreDeferred;
    for (let entity of store.state.id.values()) {
      if (entity.role === ServerMessageRole.Main) {
        return this.editManagedMessage(store.indexes.id(entity), options as MessageEditOptions);
      }
    }
    return this.sendMessage(options, ServerMessageRole.Main);
  }

  async setup(): Promise<ServerMessageManager> {
    let channelId = BigInt(this.channel.id);
    const rows = await schema.server_managed_message(dbPool).select({
      server_id: this.server.id,
      channel_id: channelId
    }).all();

    const messages = (await Promise.all(rows.map(async (row): Promise<MessageWithRole | null> => {
      try {
        let msg = await this.channel.messages.fetch(row.message_id.toString());
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

    const existingMessage$ = from(messages).pipe(map(toChange('added')));

    const messageSubject = new Subject<Change<MessageWithRole>>();

    // stop sending/editing messages during wind-down process
    const newMessages$ = messageSubject.pipe(registerInputObservable({ context: 'managedMessageSubject' }));

    let storeIndexes = { id: (entity: MessageWithRole) => BigInt(entity.msg.id) };
    const store = new EntityStore(concat(existingMessage$, newMessages$), storeIndexes, 'id') as MessageEntityStore;


    // add/remove mutexes for all existing messages
    const messageMutexMap = new Map();
    store.trackAllEntities().subscribe((change) => {
      let key = store.indexes.id(change.elt);
      if (change.type === 'added') {
        messageMutexMap.set(key, new Mutex());
      } else if (change.type === 'removed') {
        messageMutexMap.delete(key);
      }
    });


    // track when main server message is created for object consumers
    this.messageStoreDeferred.then(store =>
      firstValueFrom(store.trackAllEntities().pipe(
        filter(change => change.elt.role === ServerMessageRole.Main),
        map(getElt),
        map(elt => elt.msg)
      ))
    ).then((msg) => {
      this._mainServerMessageDeferred.resolve(msg);
    });

    this.messageMutexesDeferred.resolve(messageMutexMap);
    this.messageChangeSubjectDeferred.resolve(messageSubject);
    this.messageStoreDeferred.resolve(store);

    return this;
  }
}
//endregion
