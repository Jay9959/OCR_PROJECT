#!/usr/bin/env bash
# Install system-level apt packages from Aptfile
set -o errexit

# Install apt packages if Aptfile exists
if [ -f Aptfile ]; then
    apt-get update -qq
    cat Aptfile | xargs apt-get install -y --no-install-recommends
fi

# Install Python dependencies
pip install --upgrade pip
pip install -r requirements.txt
