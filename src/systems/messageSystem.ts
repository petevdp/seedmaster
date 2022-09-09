import { Mutex } from 'async-mutex';
import {
  DiscordAPIError,
  MessageEditOptions,
  MessageOptions,
  TextChannel
} from 'discord.js';
import deepEquals from 'lodash/isEqual';
import { concat, from, Observable, Subject } from 'rxjs';
import { ManagedMessage } from '../__generated__';
import { createObserverTarget, registerInputObservable } from '../cleanup';
import { Change, toChange } from '../lib/asyncUtils';
import { isChannelTextBased } from '../lib/discordUtils';
import { EntityStore } from '../lib/entityStore';
import { map } from '../lib/rxOperators';
import { isNonNulled } from '../lib/typeUtils';
import { dbPool, schema } from '../services/db';
import { discordClient } from '../services/discordClient';
import { instanceTenant } from '../services/instanceTenant';
import { MessageWithManaged } from './serverSystem';


//region Type
type MessageEntityStore = EntityStore<'message_id', bigint, MessageWithManaged>;
//endregion

//region State
export let messageStore: MessageEntityStore;

let messageSubject: Subject<Change<MessageWithManaged>>;
const messageIndexes = {
  message_id: (entity: MessageWithManaged) => entity.message_id
};
let messageMutexes: ReadonlyMap<bigint, Mutex>;

//endregion

export async function sendManagedMessage(options: MessageOptions | string, managedMessage: Omit<ManagedMessage, 'message_id'>) {
  const channel = await resolveChannel(managedMessage.channel_id);
  const msg = await channel.send(options);
  let messageId = BigInt(msg.id);

  const [managed] = await schema.managed_message(dbPool).insert({
    message_id: messageId,
    ...managedMessage
  });

  messageSubject.next({
    type: 'added',
    elt: managed
  });
  return msg;
}


export async function editManagedMessage(messageId: bigint, options: MessageEditOptions) {
  const managed = resolveManagedMessage(messageId);
  const mutex = await resolveMutex(messageId);
  await mutex.acquire();
  try {
    const channel = await resolveChannel(managed.channel_id);
    const editedMsg = await channel.messages.fetch(messageId.toString());
    await editedMsg.edit(options);
    messageSubject.next({
      type: 'updated',
      elt: managed
    });
    return editedMsg;
  } finally {
    mutex.release();
  }
}

export async function removeManagedMessage(messageId: bigint) {
  const entity = resolveManagedMessage(messageId);
  const mutex = await resolveMutex(messageId);
  await mutex.acquire();
  try {
    const msg = await resolveChannel(entity.channel_id);
    await msg.delete();
    await schema.managed_message(dbPool).delete({
      message_id: entity.message_id,
      channel_id: entity.channel_id
    });
    messageSubject.next({
      type: 'removed',
      elt: entity
    });
    return msg;
  } finally {
    mutex.release();
  }
}

export async function upsertMessage(options: MessageOptions | string, managedMessageOptions: Omit<ManagedMessage, 'message_id'>, uniqueType: boolean) {
  for (let entity of messageStore.state.message_id.values()) {
    let comparableManaged = { ...entity } as Partial<ManagedMessage>;
    delete comparableManaged.message_id;
    if (!uniqueType) {
      delete comparableManaged.type;
    }
    if (deepEquals(comparableManaged, managedMessageOptions)) {
      return editManagedMessage(messageStore.indexes.message_id(entity), options as MessageEditOptions);
    }
  }
  return sendManagedMessage(options, managedMessageOptions);
}

export async function setupMessages() {
  const rows = await schema.managed_message(dbPool).select({ tenant_id: instanceTenant.id }).all();
  const messages = (await Promise.all(rows.map(async (row): Promise<MessageWithManaged | null> => {
    try {
      const channel = (await discordClient.channels.fetch(row.channel_id.toString())) as TextChannel;
      if (!channel) {
        return null;
      }
      let msg = await channel.messages.fetch(row.message_id.toString());
      return row;
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 10008) {
        await schema.managed_message(dbPool).delete(row);
        return null;
      }
      throw err;
    }
  }))).filter(isNonNulled);

  const existingMessage$ = from(messages).pipe(map(toChange('added')));
  messageSubject = new Subject();
  const newMessages$ = messageSubject.pipe(registerInputObservable({ context: 'managedMessageSubject' }));
  let change$: Observable<Change<MessageWithManaged>> = concat(existingMessage$, newMessages$);
  messageStore = new EntityStore(change$, messageIndexes, 'managedMessageStore') as MessageEntityStore;
  const _messageMutexes = new Map<bigint, Mutex>();
  createObserverTarget(messageStore.trackAllEntities(), { context: 'trackMessageMutexes' }, {
    next: (change) => {
      const key = messageStore.indexes.message_id(change.elt);
      if (change.type === 'added') {
        _messageMutexes.set(key, new Mutex());
      } else if (change.type === 'removed') {
        _messageMutexes.delete(key);
      }
    }
  });
  messageMutexes = _messageMutexes;
}

//region Errors
class MessageNotTrackedError extends Error {
  constructor(messageId: bigint) {
    super(`message ${messageId} is not tracked`);
  }

}

//endregion

function resolveManagedMessage(messageId: bigint) {
  const entity = messageStore.state.message_id.get(messageId);
  if (!entity) {
    throw new MessageNotTrackedError(messageId);
  }
  return entity;
}

async function resolveMutex(messageId: bigint) {
  const mutex = messageMutexes.get(messageId);
  if (!mutex) {
    throw new Error(`message ${messageId} is not tracked`);
  }
  return mutex;
}

async function resolveChannel(channelId: bigint) {
  const channel = await discordClient.channels.fetch(channelId.toString());
  if (!channel) {
    throw new Error('Unable to resolve channel. Channel does not exist');
  }
  if (!isChannelTextBased(channel)) {
    throw new Error('Channel is not text based');
  }
  return channel;
}

