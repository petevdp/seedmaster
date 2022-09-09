import { TextChannel } from 'discord.js';
import { mergeMap } from 'rxjs/operators';
import {
  createObserverTarget,
  getObserverCountRepr,
  tryToFlushInputObservables
} from './cleanup';
import { getChatCommandInteraction } from './lib/discordUtils';
import { baseLogger } from './services/baseLogger';
import { config, setupConfig } from './services/config';
import { dbPool, schema } from './services/db';
import { discordClient, setupDiscordClient } from './services/discordClient';
import {
  getInstanceGuild,
  setupInstanceTenant
} from './services/instanceTenant';
import {
  commandNames,
  setupDiscordCommands
} from './systems/discordCommandsSystem';
import { setupMessages } from './systems/messageSystem';
import { setupSeeders } from './systems/seederSystem';
import { setupServers } from './systems/serverSystem';


export default async function main() {
  setupConfig();
  await Promise.all([
    setupInstanceTenant(),
    setupDiscordClient(),
    setupDiscordCommands(),
    setupMessages(),
  ]);
  setupSeeders();
  setupServers();

  (function handleGenericChatCommands() {
    const chatCommandInteraction$ = getChatCommandInteraction(discordClient);

    // handle reset messages
    createObserverTarget(chatCommandInteraction$.pipe(
      mergeMap(async interaction => {
        if (interaction.commandName !== commandNames.resetMessages) return;
        await interaction.reply({ ephemeral: true, content: 'Deleting....' });
        const guild = await getInstanceGuild();
        const botMember = await guild.members.fetch(config.discord_client_id);
        const channel = (await guild.channels.fetch(config.seeding_channel_id)) as TextChannel;
        const messages = await channel!.messages.fetch();
        await messages.map(async (msg) => {
          baseLogger.debug(`author: ${msg.author.id} === bot: ${botMember.id}`);
          if (msg.author.id === botMember.id) {
            await msg.delete();
            schema.managed_message(dbPool).delete({
              message_id: BigInt(msg.id),
              channel_id: BigInt(channel.id)
            });
          }
        });
        const dmChannel = botMember.user.dmChannel?.fetch();
        // await interaction.reply({
        //   ephemeral: true,
        //   content: 'all bot messages deleted!'
        // });
      })
    ), { context: 'resetMessages' });
  })();

  (function watchForProcessInturrupt() {
    // ensure SIGINT is emitted properly on windows
    var win32 = process.platform === 'win32';
    if (win32) {
      var readline = require('readline'),
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

      rl.on('SIGINT', function() {
        process.emit('SIGINT');
      });
    }

    process.on('SIGINT', async () => {
      baseLogger.info('received SIGINT, winding down...');
      if (config.debug?.flush_observables === undefined || config.debug.flush_observables) await tryToFlushInputObservables();
      baseLogger.info('Exiting');
      process.exit();
    });
  })();

  baseLogger.debug(`Active observers on main end: ${getObserverCountRepr()}`);
}

