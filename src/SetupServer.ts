import { ConnectionPool } from '@databases/pg';
import { Mutex } from 'async-mutex';
import hoursToMilliseconds from 'date-fns/hoursToMilliseconds';
import SteamAPI from 'steamapi';
import partial from 'lodash/partial';
import flow from 'lodash/flow';
import discord, {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
  MessageOptions,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import GameDig from 'gamedig';
import {
  EMPTY, of,
  BehaviorSubject,
  combineLatest,
  from,
  interval,
  Observable,
  Subscription, throwError, ConnectableObservable, Subject
} from 'rxjs';
import {
  catchError,
  concatAll,
  concatMap,
  map,
  mergeMap,
  startWith,
  filter,
  switchMap,
  takeWhile,
  distinct,
  mergeAll,
  scan
} from 'rxjs/operators';
import { Seeder, SeedLog, Server, Tenant } from './__generated__';
import {
  DeferredBehaviorSubject,
  Future,
  FutureBehaviorSubject,
  FutureSubject,
  getFirstAfterDeferred
} from './asyncUtils';
import { config } from './config';
import * as schema from './db';
import {
  getInteractionObservable,
  getReactionObservable,
  getMessageReactionsObservableWithCurrent,
  getPresenceObservable
} from './discordUtils';
import { InteractionError } from './interactionError';
import { Change, EndReason, getScanned, TimedChange } from './manageSeeders';
import { NotifyStatus, NotifyWhen } from './models';
import { getServerPlayerChange$, queryGameServer } from './squadServer';

export class SetupServer {
  // avoid top level awaits in setup
}


export function setupServer(server: Server,
                            discordClient: discord.Client,
                            steam: SteamAPI,
                            tenant: Tenant,
                            db: ConnectionPool,
                            seeder$: Observable<Change<Seeder>>,
                            allSeedersByDiscordId: Map<bigint, Seeder>) {
  const masterSub: Subscription = new Subscription();


  let observeNotifyStatusForServer = (discordId: bigint, steamId: bigint, notifySetting$: Observable<NotifyWhen>) =>
    observeNotifyStatus(discordClient, tenant, discordId, steamId, notifySetting$);

  const deferredChannel: Promise<TextChannel> = (async () => {
    const channel = await discordClient.channels.fetch(config.seeding_channel_id);
    if (channel === null) {
      throw new Error(`seed channel for server ${server.host}:${server.query_port} does not exist`);
    }
    return channel as discord.TextChannel;
  })();


  // fetch game server updates on an interval
  const deferredGameServerUpdate$: DeferredBehaviorSubject<GameDig.QueryResult> = ((async () => {
    const getResource = () => queryGameServer(server.host, server.query_port);
    const sub: BehaviorSubject<GameDig.QueryResult> = new BehaviorSubject(await getResource());
    const updates = interval(10000).pipe(switchMap(async () => getResource()));
    updates.subscribe(sub);
    return sub;
  })());

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
  const msgMutex: Mutex = new Mutex();

  // update displayed server status
  deferredGameServerUpdate$.then(update$ => {
    const sub = update$.subscribe(
      async (gameserver) => {
        await msgMutex.runExclusive(async () => {

          const serverMessage$ = await deferredServerMessage$;
          const msg = await serverMessage$.value.fetch();
          const embed = msg.embeds[0];

          let field: discord.APIEmbedField | undefined = embed.fields.find(f => f.name.startsWith('Status: '));
          if (!field) {
            field = { name: 'Status: ', value: '' };
            embed.fields.push(field as discord.APIEmbedField);
          }

          field.value = formatStatusField(gameserver.players.length, gameserver.maxplayers, server.seed_min_players as number);
          serverMessage$.next(await msg!.edit({ embeds: [embed] }));
        });
      }
    );
    masterSub.add(sub);
  });

  // manage and record seeding sessions
  (function setupSeeding() {
    const serverPlayerChange$ = getServerPlayerChange$(server);

    let deferredServerSeeder$: Promise<ConnectableObservable<Change<Seeder>>> = (async () => {
      // listen for seeder reactions and track on the database
      let message = await getFirstAfterDeferred(deferredServerMessage$);
      const o: Observable<Change<Seeder>> = getMessageReactionsObservableWithCurrent(discordClient, message as discord.Message).pipe(
        mergeMap(async (reactionChange): Promise<Change<Seeder> | undefined> => {
          const { reaction, user } = reactionChange.elt;
          if (reaction.message.id !== message.id) return;
          const seeder = allSeedersByDiscordId.get(BigInt(user.id));
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

      // ensure all subscribers get all emissions
      const out = new ConnectableObservable(o, () => new Subject());
      // subscribe to guarantee we're always tracking new seeders
      out.subscribe(() => {
      });
      return out;
    })();


    const seederNotifyStatus$ = new Observable<Change<Seeder>>(s => {

      // seederid / sub
      let subs: Map<number, Subscription> = new Map();
      const seederSub = deferredServerSeeder$.then(serverSeeder$ => serverSeeder$.subscribe(async (seederChange) => {
        switch (seederChange.type) {
          case 'added': {
            const changesForSeeder$ = serverSeeder$.pipe(filter(s => s.elt.id === seederChange.elt.id), takeWhile(s => s.type !== 'removed'));
            const updated$ = changesForSeeder$.pipe(filter(s => s.type === 'updated'));
            const notifySetting$: Observable<NotifyWhen> = updated$.pipe(map(({ elt }) => elt.notify_when), startWith(seederChange.elt.notify_when), distinct());
            const shouldNotify$: Observable<boolean> = observeNotifyStatusForServer(seederChange.elt.discord_id, seederChange.elt.steam_id, notifySetting$);

            const sub = shouldNotify$.subscribe(shouldNotify => {
              const seeder = allSeedersByDiscordId.get(seederChange.elt.discord_id) as Seeder;
              s.next({
                elt: seeder,
                type: shouldNotify ? 'added' : 'removed'
              });
            });
            subs.set(seederChange.elt.id, sub);
            break;
          }
          case 'removed': {
            subs.get(seederChange.elt.id)!.unsubscribe();
            subs.delete(seederChange.elt.id);
            break;
          }
        }
      }));

      return async () => {
        (await seederSub).unsubscribe();
        for (let sub of subs.values()) sub.unsubscribe();
      };
    });


    // get all seeders for this server that should be notified should the server have a seeding session
    const allAvailableSeeder$ = seederNotifyStatus$.pipe(
      scan((set, statusChange) => {
        const newSet = new Set(set.values());
        const currIds = new Set(allSeedersByDiscordId.keys());
        for (let seederId of newSet.values()) {
          if (!currIds.has(seederId)) {
            newSet.delete(seederId);
          }
        }
        if (statusChange.type === 'added' && currIds.has(statusChange.elt.steam_id)) {
          newSet.add(statusChange.elt.steam_id);
        }
        if (statusChange.type == 'removed') {
          newSet.delete(statusChange.elt.steam_id);
        }
        return newSet;
      }, new Set() as Set<bigint>)
    );


    const serverPlayerChanges$ = serverPlayerChange$.pipe(map(getScanned(player => player.steamID)), startWith([]));
    const seedSession$ = new Observable<TimedChange<Observable<Seeder>>>((s) => {

      // null means we're initializing
      let seeding: boolean | null = null;
      let prevSeeders: Seeder[] = [];
      combineLatest([serverPlayerChanges$, allAvailableSeeder$]).subscribe({
        complete: () => s.complete(),
        next: ([players, seeders]) => {
          const uniquePlayers = new Set([...players.map(p => BigInt(p.steamID)), ...seeders]);
          const newSeeders = [...seeders]
            .filter(id => !prevSeeders.map(ps => ps.steam_id).includes(id))
            .map(id => allSeedersByDiscordId.get(id) as Seeder || console.error('couldn\'t find seeder' + id));

          // TODO: improve heuristics for calulating when to start/abort a seed session
          if (!server.seed_min_players) throw new Error();
          const inTreshold = server!.seed_min_players <= uniquePlayers.size && uniquePlayers.size <= server.seed_max_players;
          const initializing = seeding === null;
          if ((initializing || !seeding) && inTreshold) {
            seeding = true;
            s.next({
              time: new Date(),
              elt: from(newSeeders),
              type: 'added'
            });
          }
          if (!initializing && !seeding && !inTreshold) {
            seeding = false;
            s.next({
              time: new Date(),
              elt: from(newSeeders),
              type: 'removed'
            });
          }
        }
      });
    });

    const sessionMtx = new Mutex();
    let activeSession: { id: number; sub: Subscription } | null = null;
    const sub = seedSession$.subscribe(async (sessionChange) => {
      await sessionMtx.runExclusive(async () => {
        switch (sessionChange.type) {
          case 'added': {
            const [insertedSessionLog] = await schema.seed_session_log(db).insert({
              server_id: server.id,
              start_time: sessionChange.time
            });

            // track when players join and leave the game server during seeding with seed log database entries
            let activePlayers: Map<bigint, SeedLog> = new Map();
            {
              let activePlayerMtx = new Mutex();
              const seederChangeSub = serverPlayerChange$.subscribe(async (playerChange) => {


                // const releaseMtx = await activeSeedersMtx.acquire();
                await activePlayerMtx.runExclusive(async () => {
                  const steamId = BigInt(playerChange.elt.steamID);
                  if (playerChange.type === 'added') {
                    await schema.player(db).insertOrIgnore({ steam_id: steamId });
                    const [insertedSeedLog] = await schema.seed_log(db).insert({
                      seed_session_log_id: insertedSessionLog.id,
                      player_id: steamId,
                      start_time: playerChange.time
                    });
                    activePlayers.set(steamId, insertedSeedLog);
                  }
                  if (playerChange.type === 'removed' && activePlayers.has(steamId)) {
                    const activeSeeder = activePlayers.get(steamId);
                    // this may not be defined if the session has ended already
                    if (activeSeeder) {
                      activePlayers.delete(steamId);
                      await schema.seed_log(db).update({ id: activeSeeder.id }, {
                        end_time: playerChange.time,
                        end_reason: EndReason.LEFT
                      });
                    }
                  }
                });
              });

              activeSession = {
                sub: seederChangeSub,
                id: insertedSessionLog.id
              };

            }


            // notify seeders
            {
              sessionChange.elt.subscribe(async (seeder) => {
                if (activePlayers.has(seeder.steam_id as bigint)) {
                  return;
                }
                const guild = discordClient.guilds.cache.find(g => g.id === tenant.guild_id.toString());
                if (!guild) {
                  throw new Error('tenant guild not found');
                }
                const fullGuild = await guild.fetch();
                await fullGuild.members.fetch();
                const member = fullGuild.members.cache.get(seeder.discord_id.toString());
                console.log({ presense: member!.presence });


              });
            }
            break;
          }
          case 'removed' : {
            activeSession!.sub.unsubscribe();
            await schema.seed_session_log(db).update({ id: activeSession!.id }, { end_time: sessionChange.time });
            activeSession = null;
            break;
          }
        }
      });
    });
    masterSub.add(sub);
    deferredServerSeeder$.then(ss => ss.connect());
  })();


}

function formatStatusField(length: number, maxplayers: any, seed_threshold: number) {
  return '';
}

function observeNotifyStatus(discordClient: discord.Client, tenant: Tenant, discordId: bigint, steamId: bigint, notifySetting$: Observable<NotifyWhen>): Observable<boolean> {
  const presenceUpdate$ = getPresenceObservable(discordClient).pipe(filter(p => p.userId === discordId.toString()));
  const currentPresence$ = discordClient.guilds
    .fetch(tenant.guild_id.toString())
    .then(guild => guild.members.fetch(discordId.toString()))
    .then(member => member as unknown as discord.Presence);

  const presence$ = of(currentPresence$, presenceUpdate$).pipe(mergeAll());

  return combineLatest(presenceUpdate$, notifySetting$).pipe(
    map(([presence, notify]): boolean => {
      switch (notify) {
        case NotifyWhen.Always: {
          return true;
        }
        case NotifyWhen.Never: {
          return false;
        }
        case NotifyWhen.Online: {
          return presence.status === 'online';
        }
        case NotifyWhen.Playing: {
          return presence.activities.map(a => a.type).includes(ActivityType.Playing);
        }
      }
    }),
    distinct()
  );
}

function isServerMessage(msg: discord.Message, serverId: number): boolean {
  let embed = msg.embeds[0];
  // TODO: improve message id solution
  return !!(embed?.title?.includes(`(${serverId})`));
}
