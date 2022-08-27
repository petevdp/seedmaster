import discord, {
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
  Message
} from 'discord.js';
import { concatMap, concatAll } from 'rxjs/operators';
import { from, Observable, of } from 'rxjs';
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
  });
}

export type ReactionChange = Change<{ reaction: MessageReaction | PartialMessageReaction; user: User | PartialUser }>

export function getReactionObservable(client: discord.Client) {
  return new Observable<ReactionChange>(s => {
    function reactionAddListener(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
      s.next({ type: 'added', elt: { reaction, user } });
    }

    function reactionRemoveListener(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
      s.next({ type: 'added', elt: { reaction, user } });
    }

    client.on('messageReactionAdd', reactionAddListener);
    client.on('messageReactionRemove', reactionRemoveListener);

    return () => {
      client.off('messageReactionAdd', reactionAddListener);
      client.off('messageReactionRemove', reactionRemoveListener);
    };
  });
}


export function getMessageReactionsObservableWithCurrent(client: discord.Client, message: Message): Observable<ReactionChange> {
  const reactionObservable = getReactionObservable(client);
  const existingMessages = from(message.fetch().then(messages => messages.reactions.cache.values())).pipe(concatMap(from));
  return of(existingMessages, reactionObservable).pipe(concatAll());
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
  });
}
