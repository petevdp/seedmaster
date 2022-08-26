import express from 'express';
import { Observable } from 'rxjs';
import WebSocket from 'ws';
import { Server } from './__generated__';
import { config } from './config';
import { Change, TimedChange } from './manageSeeders';

export type Player = {
  playerID: string;
  steamID: string;
  name: string;
  teamID: string;
  squadID: string | null;
};


type SquadJSMessage = { time: Date; } & ({
  type: 'init',
  players: Player[];
} | {
  type: 'playerJoined' | 'playerLeft'
  player: Player;
});

export function getServerPlayerChange$(server: Server): Observable<TimedChange<Player>> {
  if (config.shim_squadjs) {
    return new Observable<TimedChange<Player>>((s) => {
      let players: Map<string, Player> = new Map();
      for (let player of config.shim_squadjs!.starting_players) {
        players.set(player.steamID, player);
      }
      const app = express();
      app.use(express.json());
      app.post('/players', (req, res) => {
        console.log({ postedPlayer: req.body });
        const player = req.body as Player;
        players.set(player.steamID, player);
        // TODO: format dates to match the actual logs
        s.next({
          type: 'added',
          elt: player,
          time: new Date()
        });
        res.send(200);
      });
      app.delete('/players/:id', (req, res) => {
        console.log({ deletedPlayer: req.params.id });
        const player = players.get(req.params.id);
        if (!player) {
          res.send(404);
          return;
        }
        players.delete(req.params.id);
        const time = new Date();
        s.next({ type: 'removed', time, elt: player });
        res.send(200);
      });

      const port = 2000;
      const server = app.listen(port, () => {
        console.log('squadjs shim server listening on port ' + 2000);
      });


      s.next();

      return () => {
        server.close();
      };
    });
  }
  return new Observable<TimedChange<Player>>((s) => {
    console.log('connecting to websocket ', server.squadjs_ws_addr);
    const ws = new WebSocket(server.squadjs_ws_addr);

    function openListener() {
      console.log('Socket opened with ', server.squadjs_ws_addr);
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
  });
}
