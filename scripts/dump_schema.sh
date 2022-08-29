#!/usr/bin/env bash
#docker exec -it seedmaster_db_1 "pg_dump -s -U $PG_USER -d $PG_DB -f /run/schema/schema.sql"
 docker exec -it seedmaster_db_1 pg_dump -s -U $PG_USER -d $PG_DB -f /run/schema/schema.sql

