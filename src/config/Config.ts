import * as t from 'io-ts';

const RawPlayer = t.type({
  playerID: t.string,
  steamID: t.string,
  name: t.string,
  teamID: t.string,
  squadID: t.string
});
export type RawPlayer = t.TypeOf<typeof RawPlayer>;

const ServerConfig = t.type({
  id: t.number,
  squadjs_ws_addr: t.string,
  host: t.string,
  query_port: t.number,
});


export const ConfigCodec = t.type({
  guild_id: t.string,
  discord_client_id: t.string,
  seeding_role: t.string,
  seeding_channel_id: t.string,
  servers: t.array(ServerConfig),
  seeder_threshold_coefficient: t.number,
  player_threshold_coefficient: t.number,
  seed_start_threshold: t.number,
  seed_failed_threshold: t.number,
  seed_success_player_count: t.number,
  seeder_max_response_time: t.string,
  shim_squadjs: t.union([t.undefined, t.type({
    starting_players: t.array(RawPlayer),
    port: t.number
  })])
});

export type Config = t.TypeOf<typeof ConfigCodec>;
