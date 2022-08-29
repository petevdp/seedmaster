import discord, {
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
  Message
} from 'discord.js';
import { concatMap, concatAll, mergeMap, map } from 'rxjs/operators';
import { from, Observable, of } from 'rxjs';
import { flattenDeferred } from './asyncUtils';
import { registerInputObservable } from './cleanup';
import { Change } from './manageSeeders';


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
