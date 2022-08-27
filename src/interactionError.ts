import discord from 'discord.js';
// a specific thrown error that occurs during a discord interaction that we want to notify the user about
export class InteractionError extends Error {
  constructor(msg: string, rawInteraction: discord.Interaction) {
    super(msg);
    console.log('InteractionError: ', msg, this);
    let interaction = rawInteraction as discord.ChatInputCommandInteraction<discord.CacheType>;
    if (interaction.deferred) {
      interaction.editReply({ content: msg });
    } else {
      interaction.reply({ ephemeral: true, content: msg });
    }
  }
}
