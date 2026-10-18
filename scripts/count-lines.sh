#!/bin/bash
# List .ts files over 400 lines (excluding node_modules, dist, rpc, bundled-resources)

find . -name "*.ts" \
  -not -path "*/node_modules/*" \
  -not -path "*/dist/*" \
  -not -path "*/rpc/*" \
  -not -path "*/bundled-resources/*" \
  -not -path "*/.e2e-home/*" \
  -exec wc -l {} + \
  | awk '$1 > 400 {print $1, $2}' \
  | sort -rn