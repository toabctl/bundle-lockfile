#!/bin/sh
# Runs the CycloneDX comparison on the webpack 5 / Next.js fixtures created by test/gen.cjs.
# usage: sh test/compare/fixtures.sh <fixtures-dir>     (needs network once, to install the CycloneDX plugin)
set -eu
FX=$(cd "$1" && pwd)
REPO=$(cd "$(dirname "$0")/../.." && pwd)
CDX=$FX/.tools/cyclonedx
if [ ! -d "$CDX/node_modules/@cyclonedx/webpack-plugin" ]; then
  mkdir -p "$CDX" && (cd "$CDX" && echo '{"private":true}' > package.json && npm install -q --no-audit --no-fund @cyclonedx/webpack-plugin@5.3.3 >/dev/null)
fi
export BUNDLE_LOCKFILE_CDX_DIR=$CDX NEXT_TELEMETRY_DISABLED=1
INJ="--require $REPO/test/compare/inject-cyclonedx.cjs" # loads bundle-lockfile too

run() { # fixture outdir build-cmd...
  fx=$1 out=$2; shift 2
  [ -d "$FX/$fx" ] || { echo "skip $fx (not generated)" >&2; return; }
  (cd "$FX/$fx" && rm -rf "$out" && NODE_OPTIONS="$INJ" sh -c "$*" >/dev/null 2>&1) || { echo "## $fx: build FAILED"; return; }
  node "$REPO/test/compare/report.cjs" "$FX/$fx/$out" "$fx"
}

run wp5-npm dist npm run -s build
run wp5.60-npm dist npm run -s build
run wp5.0-npm dist npm run -s build
run wp5-devdeps-npm dist npm run -s build
run edge-alias dist npm run -s build
run edge-babel dist npm run -s build
run edge-css dist npm run -s build
run edge-asset dist npm run -s build
run edge-dll dist npm run -s build
run edge-workspace dist npm run -s build
run next15 .next ./node_modules/.bin/next build
run next16 .next ./node_modules/.bin/next build --webpack
