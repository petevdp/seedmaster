import discord, {
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User
} from 'discord.js';
import { from, Observable, of } from 'rxjs';
import { concatAll, mergeMap } from 'rxjs/operators';
import { registerInputObservable } from '../cleanup';
import { logger } from '../globalServices/logger';
import { flattenDeferred, Change } from './asyncUtils';


export function getInteractionObservable(client: discord.Client) {

  return new Observable<discord.Interaction>(s => {

    function listener(interaction: discord.Interaction) {
      s.next(interaction);
    }

    client.on('interactionCreate', listener);

    return () => {
      client.off('interactionCreate', listener);
    };
  }).pipe(registerInputObservable());
}

export type ReactionChange = Change<{ reaction: MessageReaction | PartialMessageReaction; userId: bigint }>

export function getReactionObservable(client: discord.Client) {
  return new Observable<ReactionChange>(s => {
    function reactionAddListener(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
      s.next({
        type: 'added',
        elt: { userId: BigInt(user.id), reaction }
      });
    }

    function reactionRemoveListener(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
      s.next({
        type: 'removed',
        elt: { userId: BigInt(user.id), reaction }
      });
    }

    client.on('messageReactionAdd', reactionAddListener);
    client.on('messageReactionRemove', reactionRemoveListener);

    return () => {
      client.off('messageReactionAdd', reactionAddListener);
      client.off('messageReactionRemove', reactionRemoveListener);
    };
  }).pipe(registerInputObservable());
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

  return of(existingReactions, reactionObservable).pipe(concatAll(), registerInputObservable());
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
  }).pipe(registerInputObservable());
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


