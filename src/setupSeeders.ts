import { sql } from '@databases/pg';
import { DiscordAPIError } from '@discordjs/rest';
import { Mutex } from 'async-mutex';
import parseHumanDate from 'parse-human-date';
import discord, {
  ActivityType,
  ButtonInteraction,
  Interaction,
  Message,
  ModalSubmitInteraction,
  SelectMenuInteraction,
  TextChannel
} from 'discord.js';
import {
  combineLatest, concat,
  EMPTY,
  from,
  merge,
  Observable,
  Observer,
  of
} from 'rxjs';
import {
  catchError,
  concatAll,
  concatMap,
  distinct,
  filter,
  map,
  mergeAll,
  mergeMap,
  share,
  startWith,
  tap
} from 'rxjs/operators';
import { Seeder } from './__generated__';
import { createObserverTarget } from './cleanup';
import { config } from './config';
import { dbPool, schema } from './db';
import { discordClientDeferred } from './discordClient';
import {
  controlPanelMessage,
  mainSignupMessage,
  messageButtonIds, pauseNotificationsModal, pauseNotificationsModalIds,
  signUpModal,
  signupModalIds, signUpPromptMessage,
  welcomeMessage
} from './discordComponents';
import { logger, MetadataError, steamClient } from './globalServices/logger';
import { getInstanceGuild, instanceTenantDeferred } from './instanceTenant';
import { Change, flattenDeferred, getElt, toChange } from './lib/asyncUtils';
import {
  catchInteractionError,
  getInteractionObservable,
  getPresenceObservable,
  InteractionError,
  isButtonInteraction,
  isModalSubmissionInteraction,
  isSelectObservable, ReactionChange
} from './lib/discordUtils';
import {
  EntityStore,
  getIdentityIndex, IdentityIndex,
  IndexCollection
} from './lib/entityStore';
import { Future } from './lib/future';
import { endWith, skipWhile, withLatestFrom } from './lib/rxOperators';
import { enumRepr, isDefined, isNonNulled } from './lib/typeUtils';
import { NotifyWhen } from './models';
import compareAsc from 'date-fns/compareAsc';

type indexLabels = 'discordId' | 'steamId'
const seederIndexes: IndexCollection<indexLabels, bigint, Seeder> = {
  discordId: elt => elt.discord_id,
  steamId: elt => elt.steam_id
};
type SeederEntityStore = EntityStore<indexLabels, bigint, Seeder>;
const _seedersDeferred = new Future<SeederEntityStore>();
export const seederStoreDeferred = _seedersDeferred as Promise<SeederEntityStore>;

type NotifiableSeederStore = EntityStore<'identity', bigint, bigint>;
const _notifiableSeederStoreDeferred = new Future<NotifiableSeederStore>();
export const notifiableSeedersStoreDeferred = _notifiableSeederStoreDeferred as Promise<NotifiableSeederStore>;


export function setupSeeders() {

  const rolesDeferred = (async function ensureRolesCreated() {
    const guild = await getInstanceGuild();
    const roles = await guild.roles.fetch();

    let role = roles.find(r => r.name === config.seeding_role);
    if (!role) {
      role = await guild.roles.create({ name: config.seeding_role });
    }
    return { seeding: role };
  })();

  (async function ensureSignupMessageCreated() {
    const discordClient = await discordClientDeferred;
    const [instanceTenant, channel] = await Promise.all([instanceTenantDeferred, discordClient.channels.fetch(config.seeding_channel_id)]);
    if (!channel!.isTextBased()) {
      throw new Error('seeding channel should be text based');
    }
    const textChannel = channel as TextChannel;
    const msgOptions = mainSignupMessage();

    if (!instanceTenant.signup_message_id) {

    }

    const persistMessageId = (msg: Message) => schema.tenant(dbPool).update({ id: instanceTenant.id }, { signup_message_id: BigInt(msg.id) });
    if (!instanceTenant.signup_message_id) {
      const msg = await textChannel.send(msgOptions);
      await persistMessageId(msg);
      return msg;
    }

    let msg: Message;
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


  const seedersFromDb$ = flattenDeferred(schema.seeder(dbPool).select().all().then(seeders => from(seeders)));
  const existingSeeder$ = seedersFromDb$.pipe(map((s): Change<Seeder> => ({
    type: 'added',
    elt: s
  })));
  const interaction$ = flattenDeferred(discordClientDeferred.then(c => getInteractionObservable(c)))
  let seederInteraction$ = interaction$.pipe(
    filterNonSeederInteractions()
  );


  (function observeSignUpButtons() {
    const contextLogger = logger.child({ context: 'observeSignUpButton' });
    createObserverTarget(
      interaction$.pipe(
        filter(isButtonInteraction),
        filter((interaction) => interaction.customId === messageButtonIds.signUp)
      )
      ,
      { context: 'observeSignUpButtons' },
      {
        // get seeder from interaction
        next: async (interaction) => {
          const alreadyExists = (await schema.seeder(dbPool).count({ discord_id: BigInt(interaction.user.id) })) > 0;
          if (alreadyExists) {
            await interaction.reply({
              content: 'You\'re already signed up!',
              ephemeral: true
            });
            return;
          }


          contextLogger.info('displaying sign up modal', { user: interaction.user.toJSON() });
          const [modal] = signUpModal();
          await interaction.showModal(modal);
        }
      }
    );
  })();


  const newSeeder$: Observable<Change<Seeder>> = (function observeSignUpModalSubmission() {
    const contextLogger = logger.child({ context: 'observeSignUpModalSubmission' });
    const o = seederInteraction$.pipe(
      filter(isModalSubmissionInteraction),
      filter(interaction => interaction.customId.startsWith(signupModalIds.startOfModalId)),
      mergeMap(async (interaction): Promise<Change<Seeder> | null> => {
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

        await schema.player(dbPool).insertOrIgnore({ steam_id: steamId });
        let user: discord.GuildMember;
        try {
          const guild = await getInstanceGuild();
          user = await guild.members.fetch(interaction.user.id);
          user.roles.add((await rolesDeferred).seeding);
          const [newSeeder] = await schema.seeder(dbPool).insert({
            steam_id: steamId,
            discord_id: BigInt(interaction.user.id),
            notify_when: 1
          });
          contextLogger.info(`inserted seeder ${newSeeder.id}`, { newSeeder });

          await user.send(welcomeMessage());
          await user.send(controlPanelMessage());
          return {
            elt: newSeeder,
            type: 'added'
          };
        } catch (err: any) {
          if (err.code === '23505') {
            throw new InteractionError('you\'re already signed up!', interaction);
          }
          throw err;
        }


        return null;
      }),
      filter(isNonNulled),
      share(),
      catchError((err, o) => o)
    );
    return o;
  })();

  let updatedSeeder$: Observable<Change<Seeder>>;
  let removedSeeder$: Observable<Change<Seeder>>;
  (function handleControlPanelInteractions() {

    (function handlePauseNotificationsButton() {
      createObserverTarget(seederInteraction$.pipe(
        filter(isButtonInteraction),
        filter(interaction => interaction.customId === messageButtonIds.pauseNotifications),
        mergeMap(async (interaction) => {
          const modal = pauseNotificationsModal();
          await interaction.showModal(modal);
        })
      ), { context: 'handlePauseNotificationsButton' });
    })();

    const seederUpdateMtx = new Mutex();

    async function updateSeeder(discordId: bigint, toUpdate: Partial<Seeder>) {
      await seederUpdateMtx.acquire();
      try {
        const [updated] = await schema.seeder(dbPool).update({ discord_id: discordId }, toUpdate);
        return updated;
      } finally {
        seederUpdateMtx.release();
      }
    }

    async function removeSeeder(discordId: bigint) {
      await seederUpdateMtx.acquire();
      try {
        const seeder = (await seederStoreDeferred).state.discordId.get(discordId);
        if (!seeder) return;
        await schema.seeder(dbPool).delete({ discord_id: discordId });
        return seeder;
      } finally {
        seederUpdateMtx.release();
      }
    }

    const updateObservables: Observable<Seeder>[] = [];

    updateObservables.push((function observeNotificationSettings() {
      return seederInteraction$.pipe(
        filter(isSelectObservable),
        filter(interaction => interaction.customId === messageButtonIds.notifyWhen),
        mergeMap(async function receiveNotificationSetting(interaction) {
          const discordId = BigInt(interaction.user.id);
          const notifyWhen = parseInt(interaction.values[0]) as NotifyWhen;
          if (!isDefined(notifyWhen)) return null;
          const updated = await updateSeeder(discordId, { notify_when: notifyWhen });
          interaction.reply({
            ephemeral: true,
            content: `Received new notification setting! ${enumRepr(NotifyWhen, notifyWhen)}`
          });
          return updated;
        }),
        filter(isNonNulled),
        catchInteractionError()
      );
    })());
    updateObservables.push((function observePauseNotifications() {
      return seederInteraction$.pipe(
        filter(isModalSubmissionInteraction),
        filter(interaction => interaction.customId.startsWith(pauseNotificationsModalIds.modalIdStart)),
        mergeMap(async function receivePauseNotifications(interaction) {
          const humanTime = interaction.fields.getTextInputValue(pauseNotificationsModalIds.time).trim();
          if (!humanTime) throw new InteractionError('Please provide a value', interaction);
          const date = parseHumanDate(humanTime);
          const discordId = BigInt(interaction.user.id);
          const updated = await updateSeeder(discordId, { notifications_paused_until: date });
          interaction.reply({
            ephemeral: true,
            content: `Received! notifications will be resumed on ${date.toLocaleString()}`
          });
          return updated;
        })
      );
    })());

    updateObservables.push((function observeUnpauseNotifications() {
      return seederInteraction$.pipe(
        filter(isButtonInteraction),
        filter(interaction => interaction.customId === messageButtonIds.unpauseNotifications),
        mergeMap(async function receiveUnpauseNotification(interaction) {
          const discordId = BigInt(interaction.user.id);
          const pausedUntil = (await seederStoreDeferred).state.discordId.get(discordId)!.notifications_paused_until;
          if (!isNonNulled(pausedUntil) || compareAsc(pausedUntil, Date.now()) == -1) {
            throw new InteractionError('Notifications are already unpaused', interaction);
          }
          const updated = await updateSeeder(discordId, { notifications_paused_until: null });
          interaction.reply({
            ephemeral: true,
            content: 'Notifications are now unpaused.'
          });
          return updated;
        })
      );
    })());
    updatedSeeder$ = merge(...updateObservables).pipe(map(toChange('updated')));

    removedSeeder$ = (function observeUnregisterButton() {
      return seederInteraction$.pipe(
        filter(isButtonInteraction),
        filter(interaction => interaction.customId === messageButtonIds.unregister),
        mergeMap(async (interaction): Promise<Seeder | undefined> => {
          const discordId = BigInt(interaction.user.id);
          const removed = await removeSeeder(discordId);
          interaction.reply('You have been succesfully unregistered.');

          return removed;
        }),
        filter(isDefined),
        map(elt => ({ type: 'removed', elt }))
      );
    })();
  })();


  const seeder$ = concat(existingSeeder$, merge(newSeeder$, removedSeeder$, updatedSeeder$));
  let seederStore = new EntityStore(seeder$, seederIndexes, 'seeders').setPrimaryIndex('discordId');
  _seedersDeferred.resolve(seederStore);

  const notifiableSeeder$: Observable<Change<bigint>> = (function observeNotifiableSeeders() {
    return seederStore.trackAllEntities().pipe(mergeMap((seederChange) => {
      switch (seederChange.type) {
        case 'added': {
          const seeder$ = from(seederStore.trackEntity(seederChange.elt.discord_id, 'discordId', true)).pipe(filter(change => change.type === 'removed'));
          const notifyWhen$: Observable<NotifyWhen> = seeder$.pipe(map(getElt), map((seeder) => seeder.notify_when), startWith(seederChange.elt.notify_when), distinct());
          const shouldNotify$ = observeNotifiable(seederChange.elt.discord_id, seederChange.elt.steam_id, notifyWhen$).pipe(
            endWith(false),
            // don't emit until notifications are on, so we don't try to remove a non-existant entry from the store
            skipWhile((shouldNotify) => !shouldNotify),
            map(shouldNotify => ({
              elt: seederChange.elt.discord_id,
              type: shouldNotify ? 'added' : 'removed'
            } as Change<bigint>))
          );
          return shouldNotify$;
        }
        default: {
          return EMPTY;
        }
      }
    }));
  })();
  _notifiableSeederStoreDeferred.resolve(new EntityStore(notifiableSeeder$, getIdentityIndex<bigint>(), 'notifiableSeeders'));
}

function observeNotifiable(discordId: bigint, steamId: bigint, notifySetting$: Observable<NotifyWhen>): Observable<boolean> {
  const presenceUpdate$ = getPresenceObservable().pipe(filter(p => p.userId === discordId.toString()));
  const currentPresence$ = getInstanceGuild()
    .then(guild => guild.members.fetch(discordId.toString()))
    .then(member => member.fetch())
    .then(member => member.presence as discord.Presence);

  currentPresence$.then(p => {
    logger.info(p);
  });

  const presence$ = of(currentPresence$, presenceUpdate$).pipe(mergeAll(), tap(p => logger.info(p)));
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
        default:
          throw new MetadataError(`Unhandled value for NotifyWhen: ${enumRepr(NotifyWhen, notify)}`, {
            notify,
            discordId,
            steamId
          });
      }
    }),
    distinct()
  );
}

/**
 * Only let seeder interactions the filter, and respond to interactions from non-seeders appropriately
 */
export function filterNonSeederInteractions() {
  return (observable: Observable<Interaction>): Observable<Interaction> => {
    return observable.pipe(
      withLatestFrom(seederStoreDeferred),
      filter(([interaction, store]) => {
        let seeder = store.state.discordId.get(BigInt(interaction.user.id));
        if (!seeder) {
          if (interaction.isRepliable())
            interaction.reply({
              ephemeral: true,
              content: 'You are not signed up as a Seeder!'
            });
          ensurePromptedSignup(interaction.user.id);
          return false;
        }
        return true;
      }),
      map(([interaction]) => interaction)
    );
  };
}

/**
 * Only let seeder reaction through the filter, and respond to reactions from non-seeders appropriately
 */
export function filterNonSeederReactions() {
  return (observabe: Observable<ReactionChange>): Observable<ReactionChange> => {
    return observabe.pipe(
      withLatestFrom(seederStoreDeferred),
      filter(([interaction, store]) => {
        if (store.state.discordId.has(interaction.elt.userId)) {
          ensurePromptedSignup(interaction.elt.userId.toString());
          return false;
        }
        return true;
      }),
      map(([change]) => change)
    );
  };
}


export async function ensurePromptedSignup(discordUserId: string) {
  const [{ count }] = (await dbPool.query(sql`SELECT COUNT(*)
                                              FROM users_prompted_for_signup
                                              WHERE discord_id ? ${discordUserId}`)) as [{ count: bigint }];
  if (count !== 0n) return;
  const guildMember = await (await getInstanceGuild()).members.fetch(discordUserId);
  guildMember.send({ ...(await signUpPromptMessage(guildMember.user)) });
}
