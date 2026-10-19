#!/bin/bash
# search.peptides' own Redis on dev2, for the updater daemon's BullMQ queue
# (@profullstack/scraper-daemon). One Redis per site, as the fleet does:
# redis:8-alpine, loopback only, AOF on, noeviction (BullMQ requires it), its own volume.
# Idempotent: creates the container once, leaves a running one alone. REDIS_URL in the
# app.env (vault profullstack/search-peptides--prod) is redis://127.0.0.1:6392.
set -euo pipefail
NAME=search-peptides-redis
PORT=6392
if docker inspect --type container "$NAME" >/dev/null 2>&1; then
  [ "$(docker inspect --type container -f '{{.State.Running}}' "$NAME")" = true ] || docker start "$NAME" >/dev/null
else
  docker run -d --name "$NAME" --restart unless-stopped \
    --memory 384m --memory-swap 384m \
    -p "127.0.0.1:${PORT}:6379" -v search-peptides-redis:/data \
    redis:8-alpine redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy noeviction >/dev/null
fi
for i in $(seq 1 20); do
  [ "$(docker exec "$NAME" redis-cli ping 2>/dev/null)" = PONG ] && { echo "redis: $NAME on 127.0.0.1:$PORT"; exit 0; }
  sleep 0.5
done
echo "redis: $NAME did not answer" >&2
exit 1
