#!/bin/bash
# Everything a deploy does once /opt/search.peptides is at the merged commit. Run by
# the forced command (deploy/search-peptides-deploy), from the checkout, as root.
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep the installed forced command in step with the repo's copy.
install -m 755 deploy/search-peptides-deploy /usr/local/bin/search-peptides-deploy
# An online copy of the database before the new code starts and migrates it. A failed copy
# stops the deploy. The newest 5 are kept, handed to anthony beside the nightly copies
# (/home/anthony/Backups/root-db/search-peptides/, which root-db-backup also ships to dev3).
DB=/root/.local/share/search-peptides/peptides.db
if [ -f "$DB" ]; then
  out_dir=/home/anthony/Backups/root-db/search-peptides
  install -d -o anthony -g anthony -m 700 "$out_dir"
  tmp=$(mktemp /root/.search-peptides-predeploy.XXXXXX)
  sqlite3 "$DB" ".backup '$tmp'"
  [ "$(sqlite3 "$tmp" 'PRAGMA quick_check')" = ok ] || { echo "after-checkout: backup failed quick_check" >&2; rm -f "$tmp"; exit 4; }
  gzip -9 -f "$tmp"
  file="$out_dir/search-peptides-predeploy-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD).sqlite.gz"
  install -o anthony -g anthony -m 600 "$tmp.gz" "$file"
  rm -f "$tmp.gz"
  ls -1t "$out_dir"/search-peptides-predeploy-*.sqlite.gz | tail -n +6 | xargs -r rm -f
  echo "after-checkout: database backed up to $file"
fi
# The daemon's Redis first: the app connects to it on boot.
bash ./deploy/redis.sh
exec ./bin/install.sh
