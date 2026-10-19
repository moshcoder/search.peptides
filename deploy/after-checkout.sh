#!/bin/bash
# Everything a deploy does once /opt/search.peptides is at the merged commit. Run by
# the forced command (deploy/search-peptides-deploy), from the checkout, as root.
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep the installed forced command in step with the repo's copy.
install -m 755 deploy/search-peptides-deploy /usr/local/bin/search-peptides-deploy
# The daemon's Redis first: the app connects to it on boot.
bash ./deploy/redis.sh
exec ./bin/install.sh
