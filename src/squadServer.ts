import express from 'express';
import { Observable } from 'rxjs';
import GameDig from 'gamedig';
import { share } from 'rxjs/operators';
import WebSocket from 'ws';
import { Server } from './__generated__';
import { config } from './config';
import { registerInputObservable } from './cleanup';
import { RawPlayer } from './config/Config';
import { logger } from './globalServices/logger';
import { Change, TimedChange } from './lib/asyncUtils';


type SquadJSMessage = { time: Date; } & ({
  type: 'init',
  players: RawPlayer[];
} | {
  type: 'playerJoined' | 'playerLeft'
  player: RawPlayer;
});


export async function queryGameServer(host: string, query_port: number) {
  if (config.shim_squadjs) {
    const res = {
      name: 'test squad server',
      players: [],
      maxplayers: 100
    } as unknown as GameDig.QueryResult;
    return res;
  }
  const res = GameDig.query({
    type: 'squad',
    host: host,
    port: query_port
  });
  return res;
}

export function observeSquadServer(server: Server): Observable<TimedChange<RawPlayer>> {
  if (!!config.shim_squadjs) {
    return new Observable<TimedChange<RawPlayer>>((s) => {
      let players: Map<string, RawPlayer> = new Map();
      for (let player of config.shim_squadjs!.starting_players) {
        players.set(player.steamID, player);
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

      const port = config.shim_squadjs!.port;
      const server = app.listen(port, () => {
        logger.info('squadjs shim server listening on port ' + port);
      });


      return () => {
        server.close();
      };
    }).pipe(share(), registerInputObservable());
  }
  return new Observable<TimedChange<RawPlayer>>((s) => {
    logger.info('connecting to websocket ', server.squadjs_ws_addr);
    const ws = new WebSocket(server.squadjs_ws_addr);

    function openListener() {
      logger.info('Socket opened with ', server.squadjs_ws_addr);
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
  }).pipe(registerInputObservable());
}
