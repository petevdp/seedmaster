import conf from '../config.json';
import { Server, Tenant } from './__generated__';
import { RawPlayer } from './squadServer';

export type ServerConfig = {
  squadjs_ws_addr: string
} & Server;

export type TopLevelConfig = {
  guild_id: bigint;
  discord_client_id: bigint
  seeding_role: 'Seeder';
  seeding_channel_id: string;
  servers: ServerConfig[];
  shim_squadjs?: {
    starting_players: RawPlayer[]
  },
}

export const config: TopLevelConfig = conf as unknown as TopLevelConfig;
