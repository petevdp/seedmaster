import { Observable } from 'rxjs';
import { Seeder, SeedSessionLog, Server } from './__generated__';


export type ServerSeeder = {
  seeder: Seeder;
  server: Server;
}

export type SeedSession = {
  server_id: number;
}

export enum EndReason { LEFT, COMPLETED, Error = 2}

export type TrackedSeedSession = Seeder[];

export function getSeederEvents(s: ServerSeeder) {
}


