import discord, {
  Interaction,
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User
} from 'discord.js';
import { from, Observable, of, fromEvent } from 'rxjs';
import { concatAll, map, mergeMap, share, mergeAll, tap } from 'rxjs/operators';
import { registerInputObservable } from '../cleanup';
import { logger, ppObj } from '../globalServices/logger';
import { flattenDeferred, Change } from './asyncUtils';


let interaction$: Observable<Interaction> | null = null;
export function getInteractionObservable(client: discord.Client): Observable<Interaction> {
  if (interaction$) return interaction$;
  interaction$ = (fromEvent(client, 'interactionCreate') as Observable<Interaction>).pipe(
    registerInputObservable({ context: 'getReactionObservable' }),
    tap((change) => logger.debug(`received discord interaction: ${ppObj(change)}`, change)),
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
      tap((change) => logger.debug(`received discord reaction change: ${ppObj(change)}`, change)),
      share()
    );
  return reaction$;
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
  return new Observable<discord.Presence>(s => {

    function listener(oldPresence: discord.Presence | null, newPresence: discord.Presence) {
      if (!newPresence) return;
      s.next(newPresence);
    }

    client.on('presenceUpdate', listener);

    return () => {
      client.off('presenceUpdate', listener);
    };
  }).pipe(registerInputObservable({ context: 'getPresenceObservable' }));
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


