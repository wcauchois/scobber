#!/bin/bash
DIR=`cat DIR_NAME`
rm -f ${DIR}/favorites.db
sqlite3 ${DIR}/favorites.db <bootstrap.sql
echo "Bootstrapped database at ${DIR}/favorites.db"
