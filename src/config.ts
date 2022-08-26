import conf from '../config.json';
import { Server, Tenant } from './__generated__';
import { Player } from './squadServer';

export type ServerConfig = {  host: string
  /**
   * @default nextval('server_id_seq'::regclass)
   */
  id: number & {readonly __brand?: 'server_id'}
  query_port: number
  seed_channel_id: string
  seed_threshold: number
  squadjs_ws_addr: string
}

export type TenantConfig = {
  guild_id: string;
  servers: ServerConfig[];
  shim_squadjs?: {
    starting_players: Player[]
  },
}

export const config: TenantConfig = conf as unknown as TenantConfig;
