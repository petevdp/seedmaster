import GameDig from 'gamedig';
import {
  ActionRowBuilder, APIEmbedField, ButtonBuilder, ButtonStyle,
  EmbedBuilder, Message, MessageEditOptions, MessageOptions
} from 'discord.js';

export type SignUpFieldIDs = {
  notifyWhen: string;
  signUpButton: string;
  unregisterButton: string;
}

export function buildSignupMessageOptions(ids: SignUpFieldIDs) {
  const signUpButton = new ButtonBuilder()
    .setCustomId(ids.signUpButton)
    .setLabel('Sign Up')
    .setStyle(ButtonStyle.Primary);

  const unregisterButton = new ButtonBuilder()
    .setCustomId(ids.unregisterButton)
    .setLabel('Unregister')
    .setStyle(ButtonStyle.Danger);

  const signUpRow = new ActionRowBuilder<ButtonBuilder>().addComponents(signUpButton, unregisterButton);
  const content = 'Sign up for server seeding to earn rewards!';
  return {
    content,
    components: [signUpRow]
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
