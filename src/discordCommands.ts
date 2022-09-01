import { REST } from '@discordjs/rest';
import {
  Routes,
  SlashCommandBuilder,
  SlashCommandIntegerOption
} from 'discord.js';
import { Server } from './__generated__';
import {
  addMasterSubscriptionSubject,
  createMasterSubscriptionEntry
} from './cleanup';
import { config } from './config';
import { environment } from './globalServices/environment';
import { logger } from './globalServices/logger';
import { Change, scanChangesToMap, scanToMap } from './lib/asyncUtils';
import { ServerWithDetails } from './models';
import {
  Observable,
  OperatorFunction
} from 'rxjs';
import { filter, map, mergeMap } from 'rxjs/operators';

export const commandNames = {
  configureServer: {
    name: 'sm-configure-server',
    subCommandAdd: 'add'
  },
  startModerated: {
    name: 'sm-start-moderated',
    options: {
      failureThreshold: 'failure-threshold',
      gracePeriod: 'grace-period',
      failureImpossible: 'failure-impossible',
      server: 'server'
    }
  }
};

export async function registerDiscordCommands(guildId: string, server$: Observable<ServerWithDetails[]>) {
  // register application commands
  const staticCommands = [
    new SlashCommandBuilder()
      .setName(commandNames.configureServer.name)
      .setDescription('reconfigure an existing server')
    // .addSubcommand((cmd) => cmd.setName(commandNames.configureServer.subCommandAdd).setDescription('Configure a new server'))
  ];

  function buildStartModeratedSeedingCommand(servers: ServerWithDetails[]) {
    return new SlashCommandBuilder()
      .setName(commandNames.startModerated.name).setDescription('Start a moderated seeding session')
      .addStringOption(option =>
        option
          .setName(commandNames.startModerated.options.server)
          .setDescription('the server to begin seeding')
          .setRequired(true)
          .setChoices(
            ...servers.map(s => ({ name: s.name, value: s.id.toString() }))
          )
      )
      .addBooleanOption((option) =>
        option
          .setName('failure-impossible')
          .setDescription('make seeding session go on forever unless explicitly stopped')
      )
      .addIntegerOption((option) =>
        option
          .setName(commandNames.startModerated.options.failureThreshold)
          .setDescription('the minimum amount of players that need to be in the server by the time the grace period ends')
      )
      .addStringOption((option) =>
        option
          .setName(commandNames.startModerated.options.gracePeriod)
          .setDescription(`A grace period time where we can\'t fail seeding (default: ${config.default_grace_period})`)
      );
  }

  const rest = new REST({ version: '10' }).setToken(environment.DISCORD_BOT_TOKEN);

  createMasterSubscriptionEntry(server$.pipe(
      filter(servers => servers.length > 0),
      map(buildStartModeratedSeedingCommand),
      mergeMap(async command => {
          await rest.put(Routes.applicationGuildCommands(config.discord_client_id, guildId), { body: [command, ...staticCommands].map(c => c.toJSON()) });
        }
      )
    ),
    { context: 'registerDynamicCommands' }
  );

  const commands = [...staticCommands];
  try {
    await rest.put(Routes.applicationGuildCommands(config.discord_client_id.toString(), guildId), { body: commands.map(c => c.toJSON()) });
  } catch (err) {
    logger.error(err);
  }
  logger.info('successfully registered application commands');
}
