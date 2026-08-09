#!/bin/sh
# Container entrypoint.
#
# Kept as a file rather than an inline startCommand on purpose: Railway parses
# and interpolates the startCommand string, and a multi-statement command
# separated by ';' was silently truncated after the first statement, which
# looked exactly like an instantly-crashing app. A script file is handed to
# /bin/sh untouched.
set -e

echo "BOOT_1_SHELL_OK"
node -v
echo "BOOT_2_NODE_OK  PORT=${PORT:-unset}  NODE_ENV=${NODE_ENV:-unset}"

# Fail loudly here rather than letting the app start against a database with
# no tables. `set -e` aborts the script if this exits non-zero.
echo "BOOT_3_PUSHING_SCHEMA"
npx prisma db push --skip-generate
echo "BOOT_4_SCHEMA_READY"

echo "BOOT_5_STARTING_APP"
# exec so node replaces the shell as PID 1 and receives SIGTERM directly —
# src/index.js has a shutdown handler that needs it.
exec node src/index.js
