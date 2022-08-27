/**
 * !!! This file is autogenerated do not edit by hand !!!
 *
 * Generated by: @databases/pg-schema-print-types
 * Checksum: Hoz5sG+rea8Zq/DkTq5kh0bEWGPsu4xn06dQmpdEThyZYo6uHVIRllO8p5gK6QXfWOE0rOAtMv78Ln18okw8kA==
 */

/* eslint-disable */
// tslint:disable

import Player, {Player_InsertParameters} from './player'
import SeedLog, {SeedLog_InsertParameters} from './seed_log'
import SeedSessionLog, {SeedSessionLog_InsertParameters} from './seed_session_log'
import Seeder, {Seeder_InsertParameters} from './seeder'
import Server, {Server_InsertParameters} from './server'
import ServerSeeder, {ServerSeeder_InsertParameters} from './server_seeder'
import Tenant, {Tenant_InsertParameters} from './tenant'

interface DatabaseSchema {
  player: {record: Player, insert: Player_InsertParameters};
  seed_log: {record: SeedLog, insert: SeedLog_InsertParameters};
  seed_session_log: {record: SeedSessionLog, insert: SeedSessionLog_InsertParameters};
  seeder: {record: Seeder, insert: Seeder_InsertParameters};
  server: {record: Server, insert: Server_InsertParameters};
  server_seeder: {record: ServerSeeder, insert: ServerSeeder_InsertParameters};
  tenant: {record: Tenant, insert: Tenant_InsertParameters};
}
export default DatabaseSchema;

function serializeValue(_tableName: string, _columnName: string, value: unknown): unknown {
  return value;
}
export {serializeValue}

export type {
  Player,
  Player_InsertParameters,
  SeedLog,
  SeedLog_InsertParameters,
  SeedSessionLog,
  SeedSessionLog_InsertParameters,
  Seeder,
  Seeder_InsertParameters,
  Server,
  ServerSeeder,
  ServerSeeder_InsertParameters,
  Server_InsertParameters,
  Tenant,
  Tenant_InsertParameters,
}
