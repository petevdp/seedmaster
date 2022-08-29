import {getConfiguredConnectionPool, tenant, server} from './db';
import { environment } from './environment';


async function main(){
  const db = await getConfiguredConnectionPool();
  const [t] = await tenant(db).insert({guild_id: BigInt("465971449954304000")});
}
main()
