import GameDig from 'gamedig'

export async function queryServer(): Promise<GameDig.QueryResult> {
  return GameDig.query({
    type: 'squad',
    host: '45.35.55.21',
    port: 7788
  });
}

