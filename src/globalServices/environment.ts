import tsEnv from '@lpgera/ts-env';
import dotenv from 'dotenv';

export type Environment = typeof environment;

export enum NodeEnv {
  PRODUCTION = 'production',
  DEVELOPMENT = 'development',
}

export const environment = (function retrieveEnvironment() {
  dotenv.config();
  const nodeEnv = tsEnv.stringOrThrow('NODE_ENV');
  if (!isNodeEnv(nodeEnv)) {
    throw new Error('Invalid NODE_ENV: ' + nodeEnv);
  }
  return {
    DISCORD_BOT_TOKEN: tsEnv.stringOrThrow('DISCORD_BOT_TOKEN'),
    STEAM_API_KEY: tsEnv.stringOrThrow('STEAM_API_KEY'),
    NODE_ENV: nodeEnv,
  };
})();


export function isNodeEnv(elt: string): elt is NodeEnv {
  return ((Object.values(NodeEnv)).includes(elt as NodeEnv));
}
