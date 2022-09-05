import GameDig from 'gamedig';
import {
  ActionRowBuilder,
  SelectMenuBuilder,
  APIEmbedField,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  Message,
  MessageEditOptions,
  MessageOptions,
  userMention,
  hyperlink,
  TextInputStyle,
  ModalBuilder,
  TextInputBuilder,
  ModalActionRowComponentBuilder,
  APISelectMenuOption,
  SelectMenuComponentOptionData,
  User
} from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import { discordClientDeferred } from './discordClient';
import { NotifyWhen } from './models';

export const messageButtonIds = {
  signUp: 'sign-up',
  unregister: 'unregister',
  pauseNotifications: 'pause-notifications',
  notifyWhen: 'notify-when', unpauseNotifications: 'unpause-notifications'

};


const signupMessageLink = Promise.resolve('http://google.com');

export type ContolPanelButtons = {}

export function mainSignupMessage() {
  const signUpButton = new ButtonBuilder()
    .setCustomId(messageButtonIds.signUp)
    .setLabel('Sign Up')
    .setStyle(ButtonStyle.Primary);


  const signUpRow = new ActionRowBuilder<ButtonBuilder>().addComponents(signUpButton);
  const content = 'Sign up for server seeding to earn rewards!';
  return {
    content,
    components: [signUpRow]
  };
}

export async function signUpPromptMessage(member: User): Promise<MessageOptions> {
  const content = `Hello ${userMention(member.id)}! To be notified of when we're seeding, please sign up below: ${await signupMessageLink}`;
  const signUpButton = new ButtonBuilder()
    .setCustomId(messageButtonIds.signUp)
    .setLabel('Sign Up')
    .setStyle(ButtonStyle.Primary);

  const signUpRow = new ActionRowBuilder<ButtonBuilder>().addComponents(signUpButton);
  return {
    content,
    components: [signUpRow]
  };
}

function seederReaction() {
  return 'SEEDER_REACTION_EMOJI';
}

export function welcomeMessage(): MessageOptions {
  return {
    content: `Thanks for signing up! make your way to ${getSeedChannel()} and react with ${seederReaction()} to be notified when seeding will start`
  };
}

export function controlPanelMessage(): MessageOptions {

  const unregisterButton = new ButtonBuilder()
    .setCustomId(messageButtonIds.unregister)
    .setLabel('Unregister')
    .setStyle(ButtonStyle.Danger);


  const notifyWhenSelect = new SelectMenuBuilder()
    .setCustomId(signupModalIds.notifyWhen)
    .setPlaceholder('Notification Settings')
    .addOptions(
      {
        label: 'Playing Squad',
        description: 'Notifies you if your discord presence shows that you\'re playing squad',
        value: NotifyWhen.PlayingSquad.toString()
      } as SelectMenuComponentOptionData,
      {
        label: 'Playing',
        description: 'Notifies you if your discord presence shows that you\'re playing any game',
        value: NotifyWhen.Playing.toString()
      } as SelectMenuComponentOptionData,

      {
        label: 'Online',
        description: 'Notifies you if discord presence shows that you\'re online',
        value: NotifyWhen.Online.toString()
      } as SelectMenuComponentOptionData,

      {
        label: 'Always',
        description: 'Always send notifications',
        value: NotifyWhen.Always.toString()
      } as SelectMenuComponentOptionData,

      {
        label: 'Never',
        description: 'Turn Notifications Off',
        value: NotifyWhen.Never.toString()
      } as SelectMenuComponentOptionData
    );

  const pauseNotificationsButton = new ButtonBuilder()
    .setCustomId(messageButtonIds.pauseNotifications)
    .setLabel('Pause Notifications')
    .setStyle(ButtonStyle.Secondary);

  const unpauseNotificationsButton = new ButtonBuilder()
    .setCustomId(messageButtonIds.unpauseNotifications)
    .setStyle(ButtonStyle.Secondary)
    .setLabel('Unpause notifications');

  const unregisterRow = new ActionRowBuilder<ButtonBuilder>().addComponents(unregisterButton);
  const notifyWhenRow = new ActionRowBuilder<SelectMenuBuilder>().addComponents(notifyWhenSelect);
  const generalButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(pauseNotificationsButton, unpauseNotificationsButton);

  return {
    content: `Manage or unregister yourself from ${getMe()} here: `,
    components: [unregisterRow, notifyWhenRow, generalButtonRow]
  };
}


export function seedSessionStart(serverName: string, numPlayers: number, successPlayerCount: number, sessionStart: Date): MessageOptions {
  const content = `Now seeding Server ${serverName}! (currently at (${numPlayers}/${successPlayerCount})) Join us!`;
  return { content };
}


export function playerJoinedSession(playerName: string, playersLeft: number): MessageOptions {
  const content = `${playerName} has joined the server! ${playersLeft} players left to go!`;
  return { content };
}


export const seedMessageEmbedFieldNames = {
  name: 'Name:',
  playerCount: 'Players:'
};

export function serverSeedMessage(serverName: string, playerCount: number): MessageOptions {

  // represents the ongoing state of the message
  const embedBuilder = new EmbedBuilder()
    .setTitle(`${serverName}`)
    .setFields();

  return {
    embeds: [embedBuilder]
  };
}

export function editServerSeedMessageMapName(msg: Message, mapName: string): MessageEditOptions | null {
  const embed = msg.embeds[0];
  let mapField: APIEmbedField | undefined = embed.fields.find(f => f.name.startsWith('Status: '));
  if (!mapField) {
    mapField = { name: 'Map: ', value: '' };
    embed.fields.push(mapField as APIEmbedField);
  }
  if (mapField.value === mapName) {
    return null;
  }

  mapField.value = mapName;

  return { embeds: [embed] };
}

export function editServerSeedMessagePlayerCount(msg: Message, playerCount: number): MessageEditOptions {
  const embed = msg.embeds[0];
  let field = embed.fields.find(f => f.name = 'players:');
  if (!field) {
    field = {
      name: 'players:',
      value: playerCount.toString()
    };
    embed.fields.push(field);
  } else {
    field.value = playerCount.toString();
  }
  return {
    embeds: [embed]
  };
}


export const signupModalIds = {
  steamId: 'steam-id',
  notifyWhen: 'notify-when',
  startOfModalId: 'sign-up-modal'
};

export function signUpModal(): [ModalBuilder, string] {
  const modalBuilder = new ModalBuilder();
  const modalId = `${signupModalIds.startOfModalId}-${uuidv4()}`
  modalBuilder
    .setTitle('Sign Up')
    .setCustomId(modalId);


  const steamIdTextInput = new TextInputBuilder()
    .setCustomId(signupModalIds.steamId)
    .setLabel('Steam Id')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);


  modalBuilder.addComponents([
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(steamIdTextInput)
  ]);

  return [modalBuilder, modalId];
}

export const pauseNotificationsModalIds = {
  time: 'time',
  modalIdStart: 'pause-notifications-modal'
};

export function pauseNotificationsModal() {
  const modalBuilder = new ModalBuilder();
  const modalId = pauseNotificationsModalIds.modalIdStart + uuidv4();
  modalBuilder
    .setTitle('Pause Notifications')
    .setCustomId(modalId);


  const timeTextInput = new TextInputBuilder()
    .setCustomId(pauseNotificationsModalIds.time)
    .setLabel('Time')
    .setRequired(true)
    .setStyle(TextInputStyle.Short);


  modalBuilder.addComponents([
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(timeTextInput)
  ]);

  return modalBuilder;
}

function getMe() {
  return 'HOW TO GET BOT DETAILS HERe';
}


function getSeedChannel() {
  return 'SEEDING CHANNEL';
}
