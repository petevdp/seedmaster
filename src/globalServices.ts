import SteamAPI from 'steamapi';
import winston from 'winston';
import { environment, NodeEnv } from './environment';


export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'what the fuck' },
  transports: [
    new winston.transports.File({
      filename: './logs/error.log',
      level: 'error'
    }),
    new winston.transports.File({ filename: './logs/combined.log' })
  ]
});


export const steamClient = new SteamAPI(environment.STEAM_API_KEY);


if (environment.NODE_ENV !== NodeEnv.PRODUCTION) {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}
