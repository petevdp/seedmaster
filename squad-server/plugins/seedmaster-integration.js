import BasePlugin from './base-plugin.js';
import { WebSocketServer } from 'ws';
import {
  from,
  fromEvent,
  concat,
  firstValueFrom,
  merge
} from 'rxjs';
import { map, takeUntil } from 'rxjs/operators';

export default class SeedmasterIntegration extends BasePlugin {
  constructor(server, options, connectors) {
    super(server, options, connectors);
    this.onWsConnection = this.onWsConnection.bind(this);
  }

  onWsConnection(ws) {
  }

  onPlayerConnected(info) {

  }

  onPlayerDisconnected(info) {
  }


  static get description() {
    return 'Integrates SquadJS with Seedmaster';
  }

  static get defaultEnabled() {
    return false;
  }


  static get optionsSpecification() {
    return {
      port: 8080
    };
  }

  log(msg) {
    console.log('seedmaster: ' + msg);
  }

  async mount() {
    await super.mount();

    this.log('integration mounted');

    const playerConnected$ = fromEvent(this.server, 'PLAYER_CONNECTED')
      .pipe(map(info => ({ type: 'added', elt: info.player })));

    const playerDisconnected$ = fromEvent(this.server, 'PLAYER_DISCONNECTED')
      .pipe(map(info => ({ type: 'removed', elt: info.player })));


    const playerChange$ = merge(playerConnected$, playerDisconnected$);


    this.wss = new WebSocketServer({ port: this.options.port });

    const wssClosed$ = firstValueFrom(fromEvent(this.wss, 'closed'));

    fromEvent(this.wss, 'connection')
      .pipe(takeUntil(wssClosed$))
      .subscribe((ws, req) => {
          const ip = req.headers['x-forwarded-for'].split(',')[0].trim();
          this.log(`Received ws connection from ${ip}`);
          const init$ = from(this.server.players.map(p => ({
            type: 'added',
            elt: p
          })));
          const wsClosed$ = firstValueFrom(fromEvent(ws, 'closed'));
          concat(init$, playerChange$)
            .pipe(takeUntil(wsClosed$))
            .subscribe(change => {
              ws.send(JSON.stringify(change));
            });

          wsClosed$.then(() => {
            this.log(`Ws connection closed for ${ip}`);
          });
        }
      );
  }

  async unmount() {
    super.unmount();
    this.wss.close();
  }
}
