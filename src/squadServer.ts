import express from 'express';
import { readFileSync } from 'fs';
import GameDig from 'gamedig';
import { asapScheduler, Observable } from 'rxjs';
import { observeOn, share } from 'rxjs/operators';
import WebSocket from 'ws';
import { Server } from './__generated__';
import { registerInputObservable } from './cleanup';
import { config } from './config';
import { RawPlayer } from './config/Config';
import { logger as masterLogger } from './globalServices/logger';
import { auditChanges, Change, TimedChange } from './lib/asyncUtils';
import { ServerDetails, ServerWithDetails } from './models';


type SquadJSMessage = { time: Date; } & ({
  type: 'init',
  players: RawPlayer[];
} | {
  type: 'playerJoined' | 'playerLeft'
  player: RawPlayer;
});


export async function queryGameServer(host: string, query_port: number): Promise<ServerDetails> {
  if (config.shim_squadjs) {
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

export function observeSquadServer(server: Server): Observable<TimedChange<RawPlayer>> {
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
        let playersToAdd: RawPlayer[] = [];
        for (let i = 0; i < count; i++) {
          const player = playersPool.pop();
          if (!player) {
            res.sendStatus(400).send('ran out of players');
            return;
          }
          playersToAdd.push(player);
        }
        for (let player of playersToAdd) {
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
      auditChanges<RawPlayer, TimedChange<RawPlayer>>(elt => elt.steamID),
      // ensure all subscribers that subscribe during this synchronous context get all events
      observeOn(asapScheduler),
      share(),
      registerInputObservable(observeSquadLogger.defaultMeta)
    );
  }
  return new Observable<TimedChange<RawPlayer>>((s) => {
    observeSquadLogger.info('connecting to websocket ', server.squadjs_ws_addr);
    const ws = new WebSocket(server.squadjs_ws_addr);

    function openListener() {
      observeSquadLogger.info('Socket opened with ', server.squadjs_ws_addr);
    }

    function closeListener() {
      s.complete();
    }

    function messageListener(msg: string) {
      const message = JSON.parse(msg) as SquadJSMessage;
      let type: Change<unknown>['type'];

      if (message.type === 'playerJoined') {
        s.next({ type: 'added', elt: message.player, time: message.time });
      } else if (message.type === 'playerLeft') {
        s.next({ type: 'removed', elt: message.player, time: message.time });
      } else if (message.type === 'init') {
        for (let player of message.players) {
          s.next({ type: 'added', elt: player, time: message.time });
        }
      }

    }

    ws.on('open', openListener);
    ws.on('close', closeListener);
    ws.on('message', messageListener);


    return () => {
      ws.close();
      ws.off('open', openListener);
      ws.off('close', closeListener);
      ws.off('message', messageListener);
    };
  }).pipe(registerInputObservable(observeSquadLogger.defaultMeta), auditChanges<RawPlayer, TimedChange<RawPlayer>>(elt => elt.steamID));
}
