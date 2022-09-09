import { Tenant } from '__generated__';
import { config } from 'services/config';
import { dbPool, schema } from 'services/db';
import { discordClientDeferred } from './discordClientSystem';
import { Future } from 'lib/future';

const _instanceTenantDeferred = new Future<Tenant>();
export const instanceTenantDeferred = _instanceTenantDeferred as Promise<Tenant>;


export async function setupInstanceTenant() {
  // get tenant info
  const [instanceTenant] = await schema.tenant(dbPool)
    .insertOrUpdate(
      ['guild_id'],
      {
        guild_id: BigInt(config.guild_id),
        seed_channel_id: BigInt(config.seeding_channel_id)
      }
    );

  _instanceTenantDeferred.resolve(instanceTenant);
  return instanceTenant;
}

export async function getInstanceGuild() {
  return (await discordClientDeferred).guilds.fetch((await instanceTenantDeferred).guild_id.toString());
}
