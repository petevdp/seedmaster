import express from 'express';
import { setTimeout } from 'timers/promises';
import { readFileSync } from 'fs';
import GameDig from 'gamedig';
import { asapScheduler, fromEvent, Observable, firstValueFrom } from 'rxjs';
import { observeOn, share } from 'rxjs/operators';
import WebSocket from 'ws';
import { Server } from '__generated__';
import { registerInputObservable } from 'cleanup';
import { config } from 'services/config';
import { RawPlayer } from 'services/config/Config';
import { baseLogger as masterLogger } from 'services/baseLogger';
import { auditChanges, Change, mapChange, TimedChange } from 'lib/asyncUtils';
import { map, takeUntil } from 'lib/rxOperators';
import { ServerDetails, ServerWithDetails } from './index';


type SquadJSMessage = TimedChange<RawPlayer>;


export async function queryGameServer(host: string, query_port: number): Promise<ServerDetails> {
  if (config.shim_squadjs) {
    // avoid sync -> async discrepancies during testing
    await setTimeout(200);
    return {
      name: 'test squad server',
      map: 'a map',
      maxplayers: 100
    } as ServerDetails;
  }
  return GameDig.query({
    type: 'squad',
    host: host,
    port: query_port
  }).then(res => ({
      name: res.name,
      map: res.map,
      maxplayers: res.maxplayers
    } as ServerDetails
  ));
}

export function observePlayerChangesFromSquadJS(server: Server): Observable<TimedChange<RawPlayer>> {
  const observeSquadLogger = masterLogger.child({ context: 'observeSquadServer' });
  if (!!config.shim_squadjs) {
    return new Observable<TimedChange<RawPlayer>>((s) => {
      let players: Map<string, RawPlayer> = new Map();
      let playersPool: RawPlayer[];
      if (typeof config.shim_squadjs!.players === 'string') {
        playersPool = JSON.parse(readFileSync(config.shim_squadjs!.players, 'utf-8'));
      } else if (config.shim_squadjs!.players instanceof Array) {
        playersPool = config.shim_squadjs!.players;
      } else {
        playersPool = [];
      }

      for (let player of playersPool.slice(0, config.shim_squadjs!.starting_count)) {
        players.set(player.steamID, player);
        s.next({ type: 'added', elt: player, time: new Date() });
      }

      const app = express();
      app.use(express.json());
      app.post('/players', (req, res) => {
        const player = req.body as RawPlayer;
        players.set(player.steamID, player);
        // TODO: format dates to match the actual logs
        s.next({
          type: 'added',
          elt: player,
          time: new Date()
        });
        res.sendStatus(201);
      });
      app.delete('/players/:id', (req, res) => {
        const player = players.get(req.params.id);
        if (!player) {
          res.sendStatus(404);
          return;
        }
        players.delete(req.params.id);
        const time = new Date();
        s.next({ type: 'removed', time, elt: player });
        res.sendStatus(200);
      });

      app.post('/addPlayer', (req, res) => {
        let count = parseInt(req.query['count'] as string);
        if (count === NaN) {
          count = 1;
        }
        for (let i = 0; i < count; i++) {
          const player = playersPool.pop();
          if (!player) {
            res.sendStatus(400).send('ran out of players');
            return;
          }
          players.set(player.steamID, player);
          // TODO: format dates to match the actual logs
          s.next({
            type: 'added',
            elt: player,
            time: new Date()
          });
        }
        res.sendStatus(200);
      });

      const port = config.shim_squadjs!.port;
      const server = app.listen(port, () => {
        observeSquadLogger.info('squadjs shim server listening on port ' + port);
      });


      return () => {
        server.close();
      };
    }).pipe(
      auditChanges<RawPlayer, string, TimedChange<RawPlayer>>(elt => elt.steamID),
      // ensure all subscribers that subscribe during this synchronous context get all events
      observeOn(asapScheduler),
      share(),
      registerInputObservable(observeSquadLogger.defaultMeta)
    );
  }

  observeSquadLogger.info('connecting to websocket ', server.squadjs_ws_addr);
  const ws = new WebSocket(server.squadjs_ws_addr);
  const closed$ = firstValueFrom(fromEvent(ws, 'close'));

  firstValueFrom(fromEvent(ws, 'open')).then(() => {
    observeSquadLogger.info('Socket opened with ', server.squadjs_ws_addr);
  });

  return (fromEvent(ws, 'message') as Observable<string>)
    .pipe(
      takeUntil(closed$),
      map(msg => JSON.parse(msg) as SquadJSMessage),
      auditChanges<RawPlayer, string, TimedChange<RawPlayer>>(elt => elt.steamID),
      registerInputObservable(observeSquadLogger.defaultMeta)
    );
}
