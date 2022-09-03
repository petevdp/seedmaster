import { sql } from '@databases/pg';
import { DiscordAPIError } from '@discordjs/rest';
import { Mutex } from 'async-mutex';
import {
  Connectable,
  from,
  Observable,
  EMPTY,
  of,
  connectable,
  combineLatest
} from 'rxjs';
import {
  map,
  tap,
  distinct,
  mergeMap,
  concatMap,
  share,
  startWith,
  catchError,
  mergeAll,
  withLatestFrom,
  filter,
  takeWhile,
  concatAll
} from 'rxjs/operators';
import { Seeder } from './__generated__';
import { createObserverTarget } from './cleanup';
import { config } from './config';
import { dbPool, schema } from './db';
import { discordClientDeferred } from './discordClient';
import {
  mainSignupMessage,
  messageButtonIds,
  signUpModal, signupModalIds
} from './discordComponents';
import { logger, MetadataError, steamClient } from './globalServices/logger';
import { getInstanceGuild, instanceTenantDeferred } from './instanceTenant';
import {
  Change, flattenDeferred
} from './lib/asyncUtils';
import {
  getInteractionObservable,
  getPresenceObservable,
  InteractionError
} from './lib/discordUtils';
import discord, {
  ActionRowBuilder, ActivityType, ButtonInteraction,
  Interaction,
  Message,
  ModalActionRowComponentBuilder, ModalBuilder,
  ModalSubmitInteraction,
  SelectMenuInteraction, TextChannel, TextInputBuilder, TextInputStyle
} from 'discord.js';
import {
  createEntityStore,
  EntityStore,
  IndexCollection
} from './lib/entityStore';
import { Future } from './lib/future';
import { enumRepr, isNonNulled } from './lib/typeUtils';
import { NotifyWhen } from './models';

type indexLabels = 'discordId' | 'steamId'
const seederIndexes: IndexCollection<indexLabels, bigint, Seeder> = {
  discordId: elt => elt.discord_id,
  steamId: elt => elt.steam_id
};
type SeederEntityStore = EntityStore<indexLabels, bigint, Seeder>;
const _seedersDeferred = new Future<SeederEntityStore>();
export const seederStoreDeferred = _seedersDeferred as Promise<SeederEntityStore>;

const _notifiableSeederStoreDeferred = new Future<SeederEntityStore>();
export const notifiableSeedersStoreDeferred = _notifiableSeederStoreDeferred as Promise<SeederEntityStore>;


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

  let deferredMainSignUpMessage: Promise<Message> = (async function ensureSignupMessageCreated() {
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
  let interaction$ = flattenDeferred(discordClientDeferred.then(c => getInteractionObservable(c)));


  const submissionModals = new Set<string>();
  (function observeSignUpButtons() {
    const contextLogger = logger.child({ context: 'observeSignUpButton' });
    createObserverTarget(
      interaction$,
      { context: 'observeSignUpButtons' },
      {
        // get seeder from interaction
        next: async (rawInteraction) => {
          const interaction = rawInteraction as ButtonInteraction;
          if (interaction.customId !== messageButtonIds.signUp) return;
          const alreadyExists = (await schema.seeder(dbPool).count({ discord_id: BigInt(interaction.user.id) })) > 0;
          if (alreadyExists) {
            await interaction.reply({
              content: 'You\'re already signed up!',
              ephemeral: true
            });
            return;
          }


          contextLogger.info('displaying sign up modal', { user: interaction.user.toJSON() });
          const [modal, modalId] = signUpModal();
          await interaction.showModal(modal);
          submissionModals.add(modalId);
        }
      }
    );
  })();


  const newSeeder$: Observable<Change<Seeder>> = (function observeSignUpModalSubmission() {
    const contextLogger = logger.child({ context: 'observeSignUpModalSubmission' });
    const o = interaction$.pipe(
      mergeMap(async (rawInteraction): Promise<Change<Seeder> | undefined> => {
        if (!rawInteraction.isModalSubmit() || !submissionModals.has(rawInteraction.customId)) return;
        submissionModals.delete(rawInteraction.customId);
        const interaction = rawInteraction as ModalSubmitInteraction;
        const rawSteamId = interaction.fields.getTextInputValue(signupModalIds.steamId).trim();
        const steamId = BigInt(rawSteamId);
        if (!steamId) throw new InteractionError('steamId is invalid', interaction);

        const notifyWhen = interaction.fields;


        try {
          await steamClient.getUserSummary([rawSteamId]);
          // TODO: perform 0auth authentication to ensure user actually owns account for steamId
        } catch (err) {
          if (!(err instanceof Error) || (err instanceof InteractionError) || !err.message.includes('No players found')) throw err;
          throw new InteractionError(`unable to find steam user with id ${steamId} `, interaction);
        }

        await schema.player(dbPool).insertOrIgnore({ steam_id: steamId });
        try {
          const guild = await getInstanceGuild();
          const user = await guild.members.fetch(interaction.user.id);
          user.roles.add((await rolesDeferred).seeding);
          const [newSeeder] = await schema.seeder(dbPool).insert({
            steam_id: steamId,
            discord_id: BigInt(interaction.user.id),
            notify_when: 1
          });
          contextLogger.info(`inserted seeder ${newSeeder.id}`, { newSeeder });
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
        return;
      }),
      share(),
      catchError((err, o) => o),
      concatMap(m => !!m ? of(m) : EMPTY)
    );
    return o;
  })();
  const updatedSeeder$: Observable<Change<Seeder>> = interaction$.pipe(
    mergeMap(async (rawInteraction): Promise<Change<Seeder> | null> => {
      const notifyWhen: NotifyWhen | undefined = (function extractNotifyWhenInteraction() {
        if (!rawInteraction.isSelectMenu()) return;
        const interaction = rawInteraction as Interaction as SelectMenuInteraction;
        if (interaction.customId !== signupModalIds.notifyWhen) return;
        const notifyWhen = parseInt(interaction.values[0]) as NotifyWhen;
        return notifyWhen;
      })();

      if (!notifyWhen) return null;

      const seeder = (await seederStoreDeferred).state.discordId.get(BigInt(rawInteraction.user.id));
      if (!seeder) throw new InteractionError(`You are not registered as a Seeder. Talk to ther server admins from ${(await getInstanceGuild()).name} for details.`, rawInteraction);
      const [updated] = await schema.seeder(dbPool).update({ id: seeder.id }, { notify_when: notifyWhen });
      return {
        elt: updated,
        type: 'updated'
      };
    }),
    filter(isNonNulled)
  );

  const removedSeeder$: Observable<Change<Seeder>> = (function observeUnregisterButton() {
    return interaction$.pipe(
      mergeMap(async (rawInteraction): Promise<Observable<Seeder>> => {
        if (!rawInteraction.isButton() || (rawInteraction as ButtonInteraction).customId !== messageButtonIds.unregister) return EMPTY;
        const discordId = BigInt(rawInteraction.user.id);
        const seeder = (await seederStoreDeferred).state.discordId.get(discordId) as Seeder;
        await schema.seeder(dbPool).delete({ discord_id: discordId });
        return !!seeder ? of(seeder) : EMPTY;
      }),
      mergeAll(),
      map(elt => ({ type: 'removed', elt }))
    );
  })();

  const seeder$ = of(existingSeeder$, newSeeder$, removedSeeder$, updatedSeeder$).pipe(concatAll());
  _seedersDeferred.resolve(createEntityStore(seeder$, seederIndexes));

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
          const shouldNotify$ = observeNotifiable(seederChange.elt.discord_id, seederChange.elt.steam_id, notifyWhen$);
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
  _notifiableSeederStoreDeferred.resolve(createEntityStore(notifiableSeeder$, seederIndexes));
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

