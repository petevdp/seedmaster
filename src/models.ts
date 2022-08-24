
export type Seeder = {
  readonly discordId: string;
  readonly steamId: string;
  readonly preferences: {
    readonly notificationsEnabled: boolean;
    readonly notifyWhen: 'online' | 'playing' | 'always'
  };
};

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
