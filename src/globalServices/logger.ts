import SteamAPI from 'steamapi';
import winston from 'winston';
import { environment, NodeEnv } from './environment';
import { prettyPrint } from '@base2/pretty-print-object';
import { format } from 'logform';


export const logger = winston.createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  defaultMeta: { context: 'default' },
  transports: [
    new winston.transports.File({
      filename: './logs/error.log',
      level: 'error'
    }),
    new winston.transports.File({ filename: './logs/combined.log' })
  ]
});


// const makeSerializable = (obj: any) => ({ })

function makeSerializable(obj: any) {
  return obj;
  return JSON.parse(JSON.stringify(obj, (_, v) => {
    return (typeof v).toLowerCase() === 'bigint' ? v.toString() : v;
  }));
}

export const ppObj = (obj: any) => prettyPrint(makeSerializable(obj), {
  indent: '\t',
  inlineCharacterLimit: 250
});

export const steamClient = new SteamAPI(environment.STEAM_API_KEY);


if (environment.NODE_ENV !== NodeEnv.PRODUCTION) {
  logger.add(new winston.transports.Console({ format: format.combine(logger.format, format.cli()) }));
}
