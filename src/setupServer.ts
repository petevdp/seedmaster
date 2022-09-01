import { ConnectionPool } from '@databases/pg';
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
  from,
  interval,
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
  switchMap,
  tap,
  withLatestFrom
} from 'rxjs/operators';
import { setTimeout } from 'timers/promises';
import {
  Player,
  Seeder,
  SeedSessionLog,
  Server,
  Tenant
} from './__generated__';
import {
  createMasterSubscriptionEntry,
  registerInputObservable
} from './cleanup';
import { config } from './config';
import * as schema from './db';
import { seed_session_log } from './db';
import { commandNames } from './discordCommands';
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
  BehaviorObservable,
  catchErrorsOfClass,
  Change,
  changeOfType,
  flattenDeferred,
  Future,
  getFirstAfterDeferred,
  mapChange,
  ResourceChange,
  scanChangesToMap,
  trackUnifiedState
} from './lib/asyncUtils';
import {
  getInteractionObservable,
  InteractionError,
  observeMessageReactions
} from './lib/discordUtils';
import { parseTimespan, TimespanParsingError } from './lib/timespan';
import { enumRepr, isNonNulled } from './lib/typeUtils';
import { EndReason } from './manageSeeders';
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
  const deferredGameServerUpdate$: Promise<BehaviorObservable<ServerWithDetails>> = (async function observeGameServerUpdates() {
    const getServerWithDetails = () => queryGameServer(server.host, server.query_port).then(details => ({ ...server, ...details }) as ServerWithDetails);
    const sub = new BehaviorSubject<ServerWithDetails>(await getServerWithDetails());
    const pollGameServerUpdate$: Observable<ServerWithDetails> = interval(minutesToMilliseconds(1)).pipe(
      registerInputObservable({ context: 'pollGameServerUpdate' }),
      switchMap(getServerWithDetails),
      distinctUntilChanged(deepEquals)
    );
    pollGameServerUpdate$.subscribe(sub);
    sub.subscribe(details => {
      console.log('details1!!');
    });
    return sub as BehaviorObservable<ServerWithDetails>;
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
    createMasterSubscriptionEntry(o, { context: 'trackAndPersistActivePlayers' });
    return o;
  })();
  const activePlayers = new Map<bigint, PlayerWithDetails>();
  createMasterSubscriptionEntry(activePlayer$, { context: 'accumulateActivePlayers' }, { next: accumulateMap(activePlayers, player => player.steam_id) });
  createMasterSubscriptionEntry(activePlayer$, { context: 'countActivePlayers' }, { next: () => logger.info(`num active players: ${activePlayers.size}`) });

  type MessageChange = ResourceChange<{ options: MessageOptions; role: ServerMessageRole }, string, { options: MessageEditOptions; role: ServerMessageRole }, Message>;
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

    const gameServerState = (await deferredGameServerUpdate$).value;
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
        filter(isNonNulled)
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
    const {
      seedSession$,
      activeSeedSessionSubject
    } = (function trackAndPersistSeedSessions() {
      const notAttendingChange$ = notAttendingSeederSubject.pipe(
        map(seeder => ({
          type: 'removed',
          elt: seeder
        } as Change<Seeder>)));

      const possiblyAttendingSeeder$ = of(notifiableServerSeeder$, notAttendingChange$).pipe(mergeAll());

      let interaction$ = flattenDeferred(discordClientDeferred.then(c => getInteractionObservable(c)));
      const chatCommandInteraction$ = interaction$.pipe(
        map((interactionRaw) => {
          if (!interactionRaw.isChatInputCommand()) return null;
          const interaction = interactionRaw as discord.ChatInputCommandInteraction;
          if (interaction.commandName !== commandNames.startModerated.name) return null;
          return interaction;
        }),
        filter(isNonNulled)
      );

      const activeSeedSessionSubject = new BehaviorSubject<SeedSessionLog | null>(null);
      let activeSessionId$ = activeSeedSessionSubject.pipe(map(session => session?.id || null));

      const invokedStartSession$: Observable<SessionStartCommandOptions> = (function listenForStartSessionCommand() {
        return chatCommandInteraction$.pipe(
          withLatestFrom(activeSessionId$),
          map(([interaction, activeSessionId]): SessionStartCommandOptions | null => {
            const serverId = Number(interaction.options.getString(commandNames.startModerated.options.server));
            if (server.id !== serverId) return null;
            const options: Partial<SessionStartCommandOptions> = {};

            if (activeSessionId) throw new InteractionError('Already in active session!', interaction);

            let gracePeriod = interaction.options.getString(commandNames.startModerated.options.gracePeriod);
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

            const failureImpossible = interaction.options.getBoolean(commandNames.startModerated.options.failureImpossible);
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

      // session is set / is being set / not yet set

      const generatedSeedSessionEvent$: Observable<SeedSessionEvent> = combineLatest([
        activePlayer$.pipe(scanChangesToMap(elt => elt.steam_id)),
        possiblyAttendingSeeder$.pipe(scanChangesToMap(elt => elt.steam_id)),
        inGracePeriod$,
        activeSessionId$
      ]).pipe(
        switchMap(async ([players, seeders, inGracePeriod, activeSessionId]) => inGracePeriod ? null : checkForAutomaticSessionChange(server, players, seeders, !!activeSessionId)),
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
        tap((event) => {
          logger.info(`posted new session event: ${ppObj({ type: enumRepr(SeedSessionEventType, event.type) })}`, event);
        }),
        filter((event) => !(event.type === SeedSessionEventType.Failure && activeSessionOptions?.failureImpossible))
      );


      const activeSessionMtx = new Mutex();
      const persistedChange$ = seedSessionEvent$.pipe(
        withLatestFrom(activeSessionId$),
        concatMap(async ([event, activeSessionId]) => {
          await activeSessionMtx.acquire();
          let change: Change<SeedSessionLog>;
          try {
            switch (event.type) {
              case SeedSessionEventType.Started: {
                if (activeSessionId) throw new Error(`activeSessionId already set when success SeedSessionEvent sent: ${activeSessionId}`);
                const [row] = await schema.seed_session_log(db).insert({
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
                const [row] = await schema.seed_session_log(db).update({ id: activeSessionId as number }, {
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
                const [row] = await schema.seed_session_log(db).update({ id: activeSessionId as number }, {
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
                const [row] = await schema.seed_session_log(db).update({ id: activeSessionId as number }, {
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
        })
      );
      createMasterSubscriptionEntry(persistedChange$, { context: 'persistedSeedSessionChange' });

      persistedChange$.pipe(
        filter(change => change.type !== 'updated'),
        map(change => change.type === 'added' ? change.elt : null)
      ).subscribe(activeSeedSessionSubject);

      return {
        seedSession$: persistedChange$,
        activeSeedSessionSubject: activeSeedSessionSubject
      };
    })();

    createMasterSubscriptionEntry(seedSession$, { context: 'seedSession' });


    // manage completeion of seed sessions
    createMasterSubscriptionEntry(from(seedSession$.toPromise().finally(async () => {
      const session = activeSeedSessionSubject.value;
      if (!session) return;
      await seed_session_log(db).update({ id: session.id }, {
        end_reason: EndReason.Error,
        end_time: new Date()
      });
      logger.warn('Closed off active seed session due to unforseen error');
    })), { context: 'ManageCompletionOfSeedSessions' });

    (function updateDisplayedServerDetails() {
      const msgMutex: Mutex = new Mutex();

      (function updateDisplayedMapName() {
        createMasterSubscriptionEntry(flattenDeferred(deferredGameServerUpdate$.then(update => update)), { context: 'updateDisplayedMapName' }, {
          next: (gameServer) =>
            msgMutex.runExclusive(async () => {
              const msg = await mainServerMessageDeferred;
              const options = editServerSeedMessageMapName(msg, gameServer.map);
              options && editManagedMessage(BigInt(msg.id), options);
            })
        });
      })();

      (function updateDisplayedPlayerCount() {
        createMasterSubscriptionEntry(activePlayer$, { context: 'updateDisplayedPlayerCount' }, {
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

      createMasterSubscriptionEntry(seedSession$.pipe(
        changeOfType('added'),
        concatMap(async session => {
          const serverDetails = (await deferredGameServerUpdate$).value;
          let options = seedSessionStart(serverDetails.name, activePlayers.size, server.seed_success_player_count, session.start_time);
          const msg = await sendManagedMessage(options, ServerMessageRole.SessionStart);
          generatedMessages.add(BigInt(msg.id));
        })
      ), { context: 'seedSessionStarted' });

      createMasterSubscriptionEntry(seedSession$.pipe(
        changeOfType('removed')
      ), { context: 'seedSessionEnded' }, {
        next: async (sessionLog) => {
          let serverName = (await getFirstAfterDeferred(deferredGameServerUpdate$)).name;
          let msg: Message;
          switch (sessionLog.end_reason as number) {
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
              throw new Error('unhandled end reason ' + enumRepr(SeedSessionEndReason, sessionLog.end_reason as number));
            }
          }
          generatedMessages.add(BigInt(msg.id));
          setTimeout(minutesToMilliseconds(1)).then(async () => {
            if (config.debug?.delete_stale_messages === false) return;
            await Promise.all([...generatedMessages.values()].map(async id => {
              await removeManagedMessage(id);
              generatedMessages.delete(id);
            }));
          });
        }
      });

      createMasterSubscriptionEntry(activePlayer$.pipe(
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
      ), { context: 'addedSeedSession' });

    })();

    const notifiedSeeder$ = (function notifyAvailableSeeders(): Observable<Seeder> {
      const deferredGuild = Promise.all([discordClientDeferred, tenantDeferred]).then(([client, tenant]) => client.guilds.fetch(tenant.guild_id.toString()));

      return seedSession$.pipe(
        changeOfType('added'),
        withLatestFrom(notifiableServerSeeder$.pipe(scanChangesToMap(seeder => seeder.discord_id))),
        mergeMap(async ([session, seeders]) => {
          const serverName = (await deferredGameServerUpdate$).value.name;
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
    createMasterSubscriptionEntry(notifiedSeeder$, { context: 'notifiedSeeder' });


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


  const gameServerUpdate$ = flattenDeferred(deferredGameServerUpdate$);


  return {
    serverSeedSignupAttempt$: seedSignupAttempt$,
    gameServerUpdate$
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
