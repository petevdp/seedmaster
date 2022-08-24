import createConnectionPool, {sql} from '@databases/pg';
import tables from '@databases/pg-typed';
import DatabaseSchema from './__generated__';
import jsonSchema from './__generated__/schema.json';

export {sql};

export const getConfiguredConnectionPool = () => createConnectionPool();

// You can list whatever tables you actually have here:
export const {server,tenant} = tables<DatabaseSchema>({
  databaseSchema: jsonSchema,
});
