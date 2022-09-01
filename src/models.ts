import { Player, Seeder, Server } from './__generated__';
import { RawPlayer } from './config/Config';
import { QueryResult } from 'gamedig';
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
  Cancelled = 2
}

export enum SeedSessionEventType {
  Success = 0,
  Failure = 1,
  Cancelled = 2,
  Started = 3,
}

export type SessionStartCommandOptions = {
  gracePeriod?: number;
  failureImpossible: boolean;
}
export type SeedSessionEvent =
  | { type: SeedSessionEventType.Started; options: SessionStartCommandOptions }
  | { type: SeedSessionEventType.Success; }
  | { type: SeedSessionEventType.Failure; }
  | { type: SeedSessionEventType.Cancelled; }


export enum ServerMessageRole {
  Main,
  SessionStart,
  PlayerJoined,
  SessionEnded,
}

export type MessageWithRole = { msg: Message; role: ServerMessageRole };

export type ServerDetails = { name: string; map: string; maxplayers: number; }
export type ServerWithDetails = Server & ServerDetails;

