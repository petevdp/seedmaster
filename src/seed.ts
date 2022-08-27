import {getConfiguredConnectionPool, tenant, server} from './db';
import { retrieveEnvironment } from './environment';


async function main(){
  retrieveEnvironment();
  const db = await getConfiguredConnectionPool();
  const [t] = await tenant(db).insert({guild_id: BigInt("465971449954304000")});
}
main()
