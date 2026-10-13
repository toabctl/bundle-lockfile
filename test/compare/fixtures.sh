#!/bin/sh
# Runs the comparison with other tools on fixtures created by test/gen.cjs: the webpack 5 / Next.js fixtures with the
# CycloneDX webpack plugin, license-webpack-plugin and webpack-license-plugin (inject-webpack-tools.cjs), the Vite and
# Rollup fixtures with rollup-plugin-license, rollup-plugin-sbom and Vite's build.license (vite.compare.mjs,
# rollup.compare.mjs). Prints one report per fixture (report.cjs); exits 1 if any difference is unexplained.
# usage: sh test/compare/fixtures.sh <fixtures-dir> [fixture-regex]   (needs network once, to install the tools)
set -eu
FX=$(cd "$1" && pwd)
ONLY=${2:-.}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
TOOLS=$FX/.tools/compare
if [ ! -f "$TOOLS/.installed-2" ]; then
  mkdir -p "$TOOLS" && (cd "$TOOLS" && echo '{"private":true}' > package.json && npm install -q --no-audit --no-fund \
    @cyclonedx/webpack-plugin@5.3.3 license-webpack-plugin@4.0.2 webpack-license-plugin@4.5.1 \
    rollup-plugin-license@3.7.1 rollup-plugin-sbom@4.0.1 >/dev/null && touch .installed-2)
fi
export BLTEST_COMPARE_DIR=$TOOLS BLTEST_COMPARE_REPO=$REPO NEXT_TELEMETRY_DISABLED=1
INJ="--require $REPO/test/compare/inject-webpack-tools.cjs" # loads bundle-lockfile too
STATUS=0

report() { node "$REPO/test/compare/report.cjs" "$1" "$2" "$3" || STATUS=1; }
# webpack: fixture outdir build-cmd...
run() {
  fx=$1 out=$2; shift 2
  echo "$fx" | grep -Eq "$ONLY" || return 0
  [ -d "$FX/$fx" ] || { echo "skip $fx (not generated)" >&2; return; }
  build() { (cd "$FX/$fx" && rm -rf "$out" && BLTEST_COMPARE_TOOLS=$1 NODE_OPTIONS="$INJ" sh -c "$cmd" > "$FX/$fx/.compare-$2.log" 2>&1); }
  cmd=$*
  failing=""
  # a tool that breaks the build: found by building with each alone, then left out (and named in the report)
  if ! build cyclonedx,lwp,wlp all; then
    ok=""
    for t in cyclonedx lwp wlp; do
      if build $t $t; then ok="$ok,$t"; else failing="$failing $t"; fi
    done
    build "${ok#,}" rest || { echo "## $fx: build FAILED"; tail -20 "$FX/$fx/.compare-rest.log"; STATUS=1; return; }
  fi
  report "$FX/$fx/$out" "$fx" "$FX/$fx"
  for t in $failing; do
    echo "- **$t fails this build** (explained: a failure of the tool, not a difference): $(grep -m1 -E 'Error|ERROR' "$FX/$fx/.compare-$t.log" | cut -c1-200)"
    echo
  done
}
# Vite / Rollup: fixture bundler [oracle args]; the oracle (an independent build with source maps) gives what is in
# the output
run_rollup() {
  fx=$1 bundler=$2; shift 2
  echo "$fx" | grep -Eq "$ONLY" || return 0
  [ -d "$FX/$fx" ] || { echo "skip $fx (not generated)" >&2; return; }
  dir=$FX/$fx
  rm -rf "$dir/dist"
  if [ "$bundler" = vite ]; then
    cp "$REPO/test/compare/vite.compare.mjs" "$dir/.compare.vite.mjs"
    cmd="./node_modules/.bin/vite build --config .compare.vite.mjs"
  else
    cp "$REPO/test/compare/rollup.compare.mjs" "$dir/.compare.rollup.mjs"
    cmd="./node_modules/.bin/rollup -c .compare.rollup.mjs"
  fi
  (cd "$dir" && NODE_OPTIONS="--require $REPO/src/register.cjs" sh -c "$cmd" > .compare.log 2>&1) || { echo "## $fx: build FAILED"; tail -20 "$dir/.compare.log"; STATUS=1; return; }
  mkdir -p "$dir/dist/bundle-lockfile-compare"
  (cd "$dir" && NODE_OPTIONS= node "$REPO/test/oracles/$bundler.cjs" "$@" | tail -1 > dist/bundle-lockfile-compare/oracle.json) || { echo "## $fx: oracle FAILED"; STATUS=1; return; }
  report "$dir/dist" "$fx" "$dir"
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
run edge-subpkg dist npm run -s build
run edge-worker dist npm run -s build
run edge-workbox dist npm run -s build
run edge-copy dist npm run -s build
run edge-context dist npm run -s build
run edge-shared-output dist npm run -s build
run edge-vanilla dist npm run -s build
run edge-virtual dist npm run -s build
run edge-manifests-wp5 dist npm run -s build
run canary-wp5 dist npm run -s build
run next15 .next ./node_modules/.bin/next build
run next16 .next ./node_modules/.bin/next build --webpack

run_rollup vite8-npm vite
run_rollup vite7-npm vite
run_rollup vite8-features vite
run_rollup canary-vite8 vite
run_rollup edge-manifests-vite8 vite
run_rollup edge-virtual-vite8 vite
run_rollup rollup-cli rollup
run_rollup canary-rollup rollup
run_rollup edge-manifests-rollup rollup
exit $STATUS
