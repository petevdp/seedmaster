import SteamAPI from 'steamapi';
import winston, {
  LeveledLogMethod,
  LogCallback,
  LogEntry,
  Logger,
  LogMethod
} from 'winston';
import { environment, NodeEnv } from './environment';
import { prettyPrint } from '@base2/pretty-print-object';
import { Format, format } from 'logform';

type LogCallbackWithMeta<T> = (
  error?: any,
  level?: string,
  message?: string,
  meta?: T
) => void;

interface LeveledLogMethodWithMeta<T> extends LeveledLogMethod {
  (message: string, callback: LogCallbackWithMeta<T>): Logger;

  (message: string, meta: T, callback: LogCallbackWithMeta<T>): Logger;

  (message: string, ...meta: T[]): Logger;

  (message: any): Logger;

  (infoObject: object): Logger;
}

interface LogMethodWithMeta<T> extends LogMethod {
  (level: string, message: string, callback: LogCallback): Logger;

  (level: string, message: string, meta: any, callback: LogCallback): Logger;

  (level: string, message: string, ...meta: any[]): Logger;

  (entry: LogEntry & T): Logger;

  (level: string, message: any): Logger;
}

export interface LoggerWithMeta<T> extends Logger {
  defaultMeta?: T;
  error: LeveledLogMethodWithMeta<T>;
  warn: LeveledLogMethodWithMeta<T>;
  help: LeveledLogMethodWithMeta<T>;
  data: LeveledLogMethodWithMeta<T>;
  info: LeveledLogMethodWithMeta<T>;
  debug: LeveledLogMethodWithMeta<T>;
  prompt: LeveledLogMethodWithMeta<T>;
  http: LeveledLogMethodWithMeta<T>;
  verbose: LeveledLogMethodWithMeta<T>;
  input: LeveledLogMethodWithMeta<T>;
  silly: LeveledLogMethodWithMeta<T>;

  // for syslog levels only
  emerg: LeveledLogMethodWithMeta<T>;
  alert: LeveledLogMethodWithMeta<T>;
  crit: LeveledLogMethodWithMeta<T>;
  warning: LeveledLogMethodWithMeta<T>;
  notice: LeveledLogMethodWithMeta<T>;
  log: LogMethodWithMeta<T>;

  child(options: LoggerMetadata): Logger;
}

type WithContext = { context: string }
export type LoggerMetadata = WithContext & { [key: string]: any };

export const logger: LoggerWithMeta<LoggerMetadata> = winston.createLogger({
  level: 'debug',
  format: format.combine(format.timestamp(), format.metadata(), format.json(), format.colorize()),
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
  inlineCharacterLimit: 150
});

export const steamClient = new SteamAPI(environment.STEAM_API_KEY);


if (environment.NODE_ENV !== NodeEnv.PRODUCTION) {
  logger.add(new winston.transports.Console({ format: format.combine(logger.format, format.cli()) }));
}
