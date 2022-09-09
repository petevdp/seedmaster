import { REST } from '@discordjs/rest';
import {
  Routes,
  SlashCommandBuilder,
  SlashCommandIntegerOption
} from 'discord.js';
import {
  createObserverTarget
} from '../cleanup';
import { config } from 'config';
import { environment } from 'services/environment';
import { baseLogger } from 'services/baseLogger';
import { instanceTenantDeferred } from './instanceTenantSystem';
import { ServerWithDetails } from '../models';
import { filter, map, mergeMap, withLatestFrom } from 'rxjs/operators';
import { seederStoreDeferred } from './seederSystem';
import {
  activeSeedSessionsDeferred,
  serverStoreDeferred
} from './serverSystem';

export const commandNames = {
  configureServer: {
    name: 'sm-configure-server',
    subCommandAdd: 'add'
  },
  resetMessages: 'sm-reset-messages',
  cancelSeedingSession: {
    name: 'sm-end-seed-session',
    options: {
      server: 'server'
    }
  },
  startSeedingSession: {
    name: 'sm-start-seed-session',
    options: {
      failureThreshold: 'failure-threshold',
      gracePeriod: 'grace-period',
      failureImpossible: 'failure-impossible',
      server: 'server'
    }
  }
};

export async function setupDiscordCommands() {
  // register application commands
  const staticCommands = [
    new SlashCommandBuilder()
      .setName(commandNames.configureServer.name)
      .setDescription('reconfigure an existing server'),
    new SlashCommandBuilder()
      .setName(commandNames.resetMessages)
      .setDescription('Resets all messages sent by the bot in the guild')
  ];


  const rest = new REST({ version: '10' }).setToken(environment.DISCORD_BOT_TOKEN);

  let commandRoutes = Routes.applicationGuildCommands(config.discord_client_id, (await instanceTenantDeferred).guild_id.toString());
  serverStoreDeferred.then(store => {
    baseLogger.info(store);

    store.change$.subscribe(change => {
      baseLogger.info(store);
      baseLogger.info(change)
    })
  })
  const serverList$= (await serverStoreDeferred).trackAllEntities().pipe(withLatestFrom(serverStoreDeferred), map(([_, servers]) => [...servers.state.id.values()]));
  const currentlySeedingServerList$ = (await seederStoreDeferred).trackAllEntities().pipe(withLatestFrom(serverStoreDeferred), map(([_, servers]) => [...servers.state.id.values()]));

  // register start seed session command
  createObserverTarget(serverList$.pipe(
      filter(servers => servers.length > 0),
      map(buildStartSeedSessionCommand),
      mergeMap(async command => {
          await rest.put(commandRoutes, { body: [command, ...staticCommands].map(c => c.toJSON()) });
        }
      )
    ),
    { context: 'registerStartSeedSessionCommand' }
  );

  (function registerCancelSeedSessionCommand() {
    // let isRegistered = false;
    // await rest.get(commandRoutes)
    createObserverTarget(currentlySeedingServerList$.pipe(
      map(buildCancelSeedSessionCommand),
      mergeMap(command =>
        rest.put(commandRoutes, { body: [command.toJSON()] })
      )
    ), { context: 'registerCancelSessionCommand' });
  })();

  const commands = [...staticCommands];
  try {
    await rest.put(commandRoutes, { body: commands.map(c => c.toJSON()) });
  } catch (err) {
    baseLogger.error(err);
  }
  baseLogger.info('successfully registered application commands');
}

function buildCancelSeedSessionCommand(seedingServers: ServerWithDetails[]) {
  return new SlashCommandBuilder()
    .setName(commandNames.cancelSeedingSession.name).setDescription('Start a moderated seeding session')
    .addStringOption(option =>
      option
        .setName(commandNames.cancelSeedingSession.options.server)
        .setDescription('the server to end seeding for')
        .setRequired(true)
        .setChoices(
          ...seedingServers.map(s => ({ name: s.name, value: s.id.toString() }))
        )
    );
}

function buildStartSeedSessionCommand(servers: ServerWithDetails[]) {
  return new SlashCommandBuilder()
    .setName(commandNames.startSeedingSession.name).setDescription('Start a moderated seeding session')
    .addStringOption(option =>
      option
        .setName(commandNames.startSeedingSession.options.server)
        .setDescription('the server to begin seeding')
        .setRequired(true)
        .setChoices(
          ...servers.map(s => ({ name: s.name, value: s.id.toString() }))
        )
    )
    .addBooleanOption((option) =>
      option
        .setName(commandNames.startSeedingSession.options.failureImpossible)
        .setDescription('make seeding session go on forever unless explicitly stopped')
    )
    .addIntegerOption((option) =>
      option
        .setName(commandNames.startSeedingSession.options.failureThreshold)
        .setDescription('the minimum amount of players that need to be in the server by the time the grace period ends')
    )
    .addStringOption((option) =>
      option
        .setName(commandNames.startSeedingSession.options.gracePeriod)
        .setDescription(`A grace period time where we can\'t fail seeding (default: ${config.default_grace_period})`)
    );
}
