import { Player, Seeder } from './__generated__';
import { RawPlayer } from './config/Config';
import { Message } from 'discord.js';

export type SeedAttempt = {
  readonly attemptId: string;
  readonly serverId: string;
  // discordId / response
  readonly responses: ReadonlyMap<string, SeederResponse>;
  readonly expectedPlayerCount: number;
  readonly createdAt: Date;
  readonly seederCount: number;
};

export type SeederResponse = {
  // seeder discord id
  readonly seederResponseId: string;
  readonly discordId: string;
  readonly attending: boolean;
  readonly createdAt: Date;
};

export type PlayerWithDetails = Player & Omit<RawPlayer, 'steamID' | 'playerID'>


export enum NotifyWhen {
  Online,
  Playing,
  Always,
  Never
}


export enum SeedSessionEndReason {
  Success = 0,
  Failure = 1,
  Aborted = 2
}


export enum ServerMessageRole {
  Main ,
  SessionStart,
  PlayerJoined,
}

export type MessageWithRole = {msg: Message; role: ServerMessageRole};
