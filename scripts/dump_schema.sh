#!/usr/bin/env bash
docker exec -it seedmaster-db-1 pg_dump -s -U $PG_USER -d $PG_DB -f /run/schema/schema.sql

