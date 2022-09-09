import { baseLogger } from 'services/baseLogger';
import { Config, ConfigCodec } from './Config';
import { readFileSync } from 'fs';
import JSON5 from 'json5';

export let config: Config;

export function setupConfig() {
  const configRaw = JSON5.parse(readFileSync('./config.json5', 'utf-8'));

  let decoded = ConfigCodec.decode(configRaw);
  if (decoded._tag === 'Left') {
    for (let error of decoded.left) {
      const path = error.context.map(node => node.key).join('/');
      baseLogger.warn(`Invalid config value at ${path}: (actual: ${(error.value as any)?.toString()}, expected: ${error.context[error.context.length - 1].type.name})`);
    }
    throw new Error('Invalid config! see above warnings for details');
  } else {
    baseLogger.info('Succesfully parsed config file');
    config = configRaw;
  }
}

