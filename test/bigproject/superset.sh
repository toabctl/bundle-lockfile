#!/bin/sh
# Real-world run on Apache Superset's frontend (webpack 5, ~260 direct dependencies).
# Run in a Wolfi container with network, e.g. on a workstation:
#   docker run --rm -v "$PWD":/repo:ro -v /var/tmp/superset:/work cgr.dev/chainguard/wolfi-base \
#     sh /repo/test/bigproject/superset.sh /work [tag]
# Writes /work/results/*.md and logs; the build runs several times, so expect a long run.
set -eu
set -o pipefail   # a failing build inside the tee'd block must fail the run
W=$1; TAG=${2:-6.1.0}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
R=$W/results; mkdir -p "$R"
apk add -q nodejs-22 npm git syft zstd >/dev/null   # zstd: superset's webpack config uses simple-zstd
# superset's engines want npm ^10.8.1; npm 12 rejects its lockfile as out of sync ("npm ci ... not in sync")
npm install -q -g npm@10 >/dev/null
hash -r   # the shell still has /usr/bin/npm (12) cached; npm 10 is in /usr/local/bin

[ -d "$W/superset" ] || git clone -q --depth 1 --branch "$TAG" https://github.com/apache/superset "$W/superset"
FE=$W/superset/superset-frontend
OUT=$W/superset/superset/static/assets   # BUILD_DIR in superset-frontend/webpack.config.js
cd "$FE"
[ -d node_modules ] || npm ci --no-audit --no-fund > "$R/npm-ci.log" 2>&1

CDX=$W/cyclonedx
[ -d "$CDX/node_modules/@cyclonedx/webpack-plugin" ] || { mkdir -p "$CDX"; (cd "$CDX" && echo '{"private":true}' > package.json && npm install -q --no-audit --no-fund @cyclonedx/webpack-plugin@5.3.3 >/dev/null); }
export BUNDLE_LOCKFILE_CDX_DIR=$CDX

MEASURE="--require $REPO/test/bigproject/measure.cjs"
TOOL="--require $REPO/src/register.cjs"
COMPARE="--require $REPO/test/compare/inject-cyclonedx.cjs" # loads bundle-lockfile too
cold() { rm -rf "$FE/.temp_cache"; }   # webpack persistent cache (cache.cacheDirectory in webpack.config.js)
lock_stats() { node -e 'const l = require(process.argv[1]); const e = Object.entries(l.packages).filter(([k]) => k);
  console.log(`${e.length} entries, ${new Set(e.map(([, p]) => p.name + "@" + p.version)).size} unique name@version`)' "$1"; }
# what superset's "build" script runs, but without cross-env replacing NODE_OPTIONS
webpack_build() { # name extra-node-options
  rm -rf "$OUT"
  echo "== $1"
  NODE_ENV=production BABEL_ENV=production NODE_OPTIONS="--max_old_space_size=8192 $MEASURE $2" \
    ./node_modules/.bin/webpack --mode production > "$R/$1.log" 2>&1 || { echo "build $1 FAILED, see $R/$1.log"; exit 1; }
  grep '\[measure\].*script=webpack' "$R/$1.log" | tail -1
}

{
  echo "# Superset $TAG frontend"
  echo
  echo "node $(node -v), npm $(npm -v), webpack $(node -p 'require("webpack/package.json").version'), $(nproc) CPUs"
  echo
  echo "## Build cost (main webpack process)"
  echo
  echo "Cold = webpack's persistent cache (.temp_cache) removed before the build; warm = cache from the previous build."
  echo
  echo '```'
  for round in 1 2; do
    cold; webpack_build "baseline-cold-$round" ""
    cold; webpack_build "bundle-lockfile-cold-$round" "$TOOL"
  done
  cp "$OUT/bundle-lockfile/package-lock.json" "$R/lockfile-cold.json"
  webpack_build baseline-warm ""
  webpack_build bundle-lockfile-warm "$TOOL"
  cp "$OUT/bundle-lockfile/package-lock.json" "$R/lockfile-warm.json"
  echo '```'
  echo
  locks=$(find "$OUT" -path '*bundle-lockfile/package-lock.json' | wc -l)
  echo "bundle-lockfile: $locks lockfile(s), $(lock_stats "$R/lockfile-cold.json")"
  if cmp -s "$R/lockfile-cold.json" "$R/lockfile-warm.json"; then
    echo "lockfile from the warm (cached) build is identical to the cold one"
  else
    echo "**lockfile from the warm (cached) build DIFFERS from the cold one** (see lockfile-cold.json / lockfile-warm.json)"
  fi
  echo
  echo "## syft"
  echo
  syft scan "dir:$OUT" -q -o json > "$R/syft-output.json"
  syft scan "file:$FE/package-lock.json" -q -o json > "$R/syft-project-lockfile.json"
  node -e '
    const read = f => new Set(require(f).artifacts.map(a => `${a.name}@${a.version}`));
    const out = read(process.argv[1]), proj = read(process.argv[2]);
    const onlyOut = [...out].filter(p => !proj.has(p)), onlyProj = [...proj].filter(p => !out.has(p));
    console.log(`| | packages |\n|---|---|\n| syft on the build output (bundle-lockfile) | ${out.size} |\n| syft on the project package-lock.json | ${proj.size} |\n| in the bundle but not reported from the project lockfile (e.g. shipped devDependencies) | ${onlyOut.length} |\n| reported from the project lockfile but not in the bundle | ${onlyProj.length} |\n`);
    console.log("shipped but missing from the project-lockfile view (first 40):", onlyOut.sort().slice(0, 40).join(" ") || "-");
  ' "$R/syft-output.json" "$R/syft-project-lockfile.json"
  echo
  echo '```'
  cold; webpack_build compare "$COMPARE"
  echo '```'
  mkdir -p "$R/compare" && cp "$OUT/cyclonedx/bom.json" "$OUT"/bundle-lockfile-compare/diag-*.json "$R/compare/" 
  echo
  node "$REPO/test/compare/report.cjs" "$OUT" "bundle-lockfile vs. CycloneDX webpack plugin"
  echo "## npm run build (the project's own script)"
  echo
  rm -rf "$OUT"
  NODE_OPTIONS="$TOOL" npm run build > "$R/npm-run-build.log" 2>&1 || echo "npm run build FAILED, see $R/npm-run-build.log"
  echo "lockfiles written: $(find "$OUT" -path '*bundle-lockfile/package-lock.json' | wc -l) (the script sets NODE_OPTIONS itself via cross-env, replacing the --require)"
} 2>&1 | tee "$R/superset.md"
