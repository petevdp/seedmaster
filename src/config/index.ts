import { logger } from '../globalServices/logger';
import { Config, ConfigCodec } from './Config';
import { readFileSync } from 'fs';


const configRaw = JSON.parse(readFileSync('./config.json', 'utf-8'));

export const config = configRaw as Config;

let decoded = ConfigCodec.decode(configRaw);
if (decoded._tag === "Left") {
  for (let error of decoded.left) {
    const path = error.context.map(node => node.key).join('/');
    logger.warn(`Invalid config value at ${path}: (actual: ${(error.value as any)?.toString()}, expected: ${error.context[error.context.length - 1].type.name})`);
  }
  throw new Error('Invalid config! see above warnings for details');
} else {
  logger.info('Succesfully parsed config file');
}

