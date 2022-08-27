import conf from '../config.json';
import { Server, Tenant } from './__generated__';
import { Player } from './squadServer';

export type ServerConfig = {
  /**
   * @default nextval('server_id_seq'::regclass)
   */
  squadjs_ws_addr: string
} & Server;

export type TenantConfig = {
  guild_id: string;
  seeding_role: 'Seeder';
  seeding_channel_id: string;
  servers: ServerConfig[];
  shim_squadjs?: {
    starting_players: Player[]
  },
}

export const config: TenantConfig = conf as unknown as TenantConfig;
