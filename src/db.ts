import createConnectionPool, {sql} from '@databases/pg';
import tables from '@databases/pg-typed';
import DatabaseSchema from './__generated__';
import jsonSchema from './__generated__/schema.json';

export {sql};

export const getConfiguredConnectionPool = () => createConnectionPool({bigIntMode: "bigint"});

// You can list whatever tables you actually have here:
export const {server,tenant, seed_log, seed_session_log, player, seeder, server_seeder} = tables<DatabaseSchema>({
  databaseSchema: jsonSchema,
});
