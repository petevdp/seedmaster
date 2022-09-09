import { Tenant } from '__generated__';
import { config } from 'services/config';
import { dbPool, schema } from 'services/db';
import { discordClient } from './discordClient';
import { Future } from 'lib/future';

export let instanceTenant: Tenant;

export async function setupInstanceTenant() {
  // get tenant info
  const [tenant] = await schema.tenant(dbPool)
    .insertOrUpdate(
      ['guild_id'],
      {
        guild_id: BigInt(config.guild_id),
        seed_channel_id: BigInt(config.seeding_channel_id)
      }
    );

  instanceTenant = tenant;
  return tenant;
}

export async function getInstanceGuild() {
  return discordClient.guilds.fetch(instanceTenant.guild_id.toString());
}
