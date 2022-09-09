import {
  TextChannel
} from 'discord.js';
import {
  mergeMap
} from 'rxjs/operators';
import {
  discordClientDeferred,
  setupDiscordClient
} from './systems/discordClientSystem';
import {
  commandNames,
  setupDiscordCommands
} from './systems/discordCommandsSystem';
import {
  setupInstanceTenant, getInstanceGuild,
  instanceTenantDeferred
} from './systems/instanceTenantSystem';
import {
  flattenDeferred
} from './lib/asyncUtils';
import { config } from './config';
import { dbPool } from './services/db';
import { schema } from './services/db';
import {
  getChatCommandInteraction
} from './lib/discordUtils';
import {
  createObserverTarget,
  tryToFlushInputObservables,
  getObserverCountRepr
} from './cleanup';
import { baseLogger } from './services/baseLogger';
import { setupSeeders } from './systems/seederSystem';
import { index } from './systems/serverSystem';


export default function main() {
  baseLogger.info('startup');

  // setup all systems
  setupInstanceTenant();
  setupDiscordClient();
  setupSeeders();
  index();
  setupDiscordCommands();

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
          baseLogger.debug(`author: ${msg.author.id} === bot: ${botMember.id}`);
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

