import { Observable } from 'rxjs';
import { Seeder, SeedSessionLog, Server } from './__generated__';

export type Change<T> = {
  elt: T;
  type: 'added' | 'removed' | 'updated';
}

export type TimedChange<T> = Change<T> & { time: Date };

export type ServerSeeder = {
  seeder: Seeder;
  server: Server;
}

export type SeedSession = {
  server_id: number;
}

export enum EndReason { LEFT, COMPLETED }

export type TrackedSeedSession = Seeder[];

export function getSeederEvents(s: ServerSeeder) {
}

export function getScanned<T,K>(getKey: (elt: T) => K) {
  const elts: Map<K, T> = new Map();
  return (change: Change<T>) => {
    const key = getKey(change.elt);
    switch (change.type) {
      case 'added':
      case 'updated':
        elts.set(key, change.elt);
        break;
      case 'removed':
        elts.delete(key);
        break;
    }
    return [...elts.values()];
  };
}

