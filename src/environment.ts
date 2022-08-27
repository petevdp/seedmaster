import { ConnectionPool } from '@databases/pg';
import tsEnv from '@lpgera/ts-env';
import dotenv from 'dotenv';

export type Environment = ReturnType<typeof retrieveEnvironment>;

export function retrieveEnvironment() {
  dotenv.config();
  return {
    DISCORD_BOT_TOKEN: tsEnv.stringOrThrow('DISCORD_BOT_TOKEN'),
    DISCORD_CLIENT_ID: tsEnv.stringOrThrow('DISCORD_CLIENT_ID'),
    STEAM_API_KEY: tsEnv.stringOrThrow('STEAM_API_KEY')
  };
}
