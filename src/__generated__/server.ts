/**
 * !!! This file is autogenerated do not edit by hand !!!
 *
 * Generated by: @databases/pg-schema-print-types
 * Checksum: 5XF4VaziWA4kiDbHaYMVBTgC+TvCjk00TYQ+RYB9KRE+drKlBgemr97+/c601YrzTdNY6IGT096Xh2QYOZPo6A==
 */

/* eslint-disable */
// tslint:disable

import Tenant from './tenant'

interface Server {
  host: string
  id: number & {readonly __brand?: 'server_id'}
  query_port: number
  seed_max_players: number
  seed_min_players: number
  squadjs_ws_addr: string
  tenant_id: Tenant['id']
}
export default Server;

interface Server_InsertParameters {
  host: string
  id: number & {readonly __brand?: 'server_id'}
  query_port: number
  seed_max_players: number
  seed_min_players: number
  squadjs_ws_addr: string
  tenant_id: Tenant['id']
}
export type {Server_InsertParameters}