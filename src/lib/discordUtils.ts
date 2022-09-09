import discord, {
  ButtonInteraction,
  Interaction,
  Message,
  MessageReaction,
  ModalSubmitInteraction,
  PartialMessageReaction,
  PartialUser,
  SelectMenuInteraction,
  User
} from 'discord.js';
import { from, Observable, of, fromEvent } from 'rxjs';
import {
  concatAll,
  map,
  mergeMap,
  share,
  mergeAll,
  filter
} from 'rxjs/operators';
import { registerInputObservable } from '../cleanup';
import { flattenDeferred, Change } from './asyncUtils';
import { catchError } from './rxOperators';
import { isNonNulled } from './typeUtils';


let interaction$: Observable<Interaction> | null = null;

export function getInteractionObservable(client: discord.Client): Observable<Interaction> {
  if (interaction$) return interaction$;
  interaction$ = (fromEvent(client, 'interactionCreate') as Observable<Interaction>).pipe(
    registerInputObservable({ context: 'getReactionObservable' }),
    // tap((change) => logger.debug(`received discord interaction: ${ppObj(change)}`, change)),
    share()
  );
  return interaction$;
}

export type ReactionChange = Change<{ reaction: MessageReaction | PartialMessageReaction; userId: bigint }>
export type MessageReactionListenerArgs = [MessageReaction | PartialMessageReaction, User | PartialUser]


let reaction$: Observable<ReactionChange> | null = null;

export function getReactionObservable(client: discord.Client): Observable<ReactionChange> {
  if (reaction$) return reaction$;
  const reactionAdd$ = (fromEvent(client, 'messageReactionAdd') as Observable<MessageReactionListenerArgs>)
    .pipe(map(([reaction, user]): ReactionChange => ({
      type: 'added',
      elt: { userId: BigInt(user.id), reaction }
    })));

  const reactionRemove$ = (fromEvent(client, 'messageReactionAdd') as Observable<MessageReactionListenerArgs>)
    .pipe(map(([reaction, user]): ReactionChange => ({
      type: 'added',
      elt: { userId: BigInt(user.id), reaction }
    })));

  reaction$ = of(reactionAdd$, reactionRemove$)
    .pipe(
      mergeAll(),
      registerInputObservable({ context: 'getReactionObservable' }),
      // tap((change) => logger.debug(`received discord reaction change: ${ppObj(change)}`, change)),
      share()
    );
  return reaction$;
}


export function getChatCommandInteraction(discordClient: discord.Client) {
  const interaction$ = getInteractionObservable(discordClient);
  return interaction$.pipe(
    map((interactionRaw) => {
      if (!interactionRaw.isChatInputCommand()) return null;
      const interaction = interactionRaw as discord.ChatInputCommandInteraction;
      return interaction;
    }),
    filter(isNonNulled)
  );
}


export function observeMessageReactions(client: discord.Client, message: Message): Observable<ReactionChange> {
  const reactionObservable = getReactionObservable(client);
  const existingReactions = flattenDeferred(message.fetch().then(message => {
    return from([...message.reactions.cache.values()]).pipe(
      mergeMap(async reaction => [reaction, [...(await reaction.users.fetch()).values()]] as [MessageReaction, discord.User[]]),
      mergeMap(([reaction, users]) => users.map(user => ({
        type: 'added',
        elt: { reaction, userId: BigInt(user.id) }
      } as ReactionChange)))
    );
  }));

  return of(existingReactions, reactionObservable).pipe(concatAll());
}


export function getPresenceObservable(client: discord.Client): Observable<discord.Presence> {
  const presenceUpdate$ = fromEvent(client, 'presenceUpdate') as Observable<[oldPresence: discord.Presence | null, newPresence: discord.Presence]>;
  return presenceUpdate$.pipe(
    map(([newPresence]) => newPresence || null),
    filter(isNonNulled),
    share(),
    registerInputObservable({ context: 'getPresenceObservable' })
  );
}

export function isButtonInteraction(interaction: Interaction): interaction is ButtonInteraction {
  return interaction.isButton();
}

export function isModalSubmissionInteraction(interaction: Interaction): interaction is ModalSubmitInteraction {
  return interaction.isModalSubmit();
}

export function isSelectObservable(interaction: Interaction): interaction is SelectMenuInteraction {
  return interaction.isSelectMenu();
}


// a specific thrown error that occurs during a discord interaction that we want to notify the user about
export class InteractionError extends Error {
  constructor(msg: string, rawInteraction: discord.Interaction) {
    super(msg);
    let interaction = rawInteraction as discord.ChatInputCommandInteraction<discord.CacheType>;
    if (interaction.deferred) {
      interaction.editReply({ content: msg });
    } else {
      interaction.reply({ ephemeral: true, content: msg });
    }
  }
}


// TODO: generalize this
export function catchInteractionError<T>() {
  return (observable: Observable<T>): Observable<T> => {
    return observable.pipe(
      catchError((err, o) => {
        if (err instanceof InteractionError) return o;
        throw err;
      })
    );
  };
}
