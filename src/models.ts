import { Seeder } from './__generated__';

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

type Config = {
  readonly seedChannel: string;
};


export enum NotifyWhen {
  Online,
  Playing,
  Always,
  Never
}

export type NotifyStatus = {
  seeder: Seeder;
  shouldNotify: boolean;
}
