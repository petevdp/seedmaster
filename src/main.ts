import {
  TextChannel
} from 'discord.js';
import {
  mergeMap
} from 'rxjs/operators';
import { discordClientDeferred, logInToDiscord } from './discordClient';
import { commandNames, registerDiscordCommands } from './discordCommands';
import {
  setupInstanceTenant, getInstanceGuild,
  instanceTenantDeferred
} from './instanceTenant';
import {
  flattenDeferred
} from './lib/asyncUtils';
import { config } from './config';
import { dbPool } from './db';
import { schema } from './db';
import {
  getChatCommandInteraction
} from './lib/discordUtils';
import {
  createObserverTarget,
  tryToFlushInputObservables,
  getObserverCountRepr
} from './cleanup';
import { logger } from './globalServices/logger';
import { setupSeeders } from './setupSeeders';
import { setupServers } from './setupServers';


export default function main() {
  logger.info('startup');

  setupInstanceTenant();
  logInToDiscord();


  (function handleGenericChatCommands() {
    const chatCommandInteraction$ = flattenDeferred(discordClientDeferred.then(c => getChatCommandInteraction(c)));

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
          logger.debug(`author: ${msg.author.id} === bot: ${botMember.id}`);
          if (msg.author.id === botMember.id) {
            await msg.delete();
            schema.server_managed_message(dbPool).delete({
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


  setupSeeders();
  setupServers();
  registerDiscordCommands();

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
      logger.info('received SIGINT, winding down...');
      if (config.debug?.flush_observables === undefined || config.debug.flush_observables) await tryToFlushInputObservables();
      logger.info('Exiting');
      process.exit();
    });
  })();

  logger.debug(`Active observers on main end: ${getObserverCountRepr()}`);
}

