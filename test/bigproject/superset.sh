#!/bin/sh
# Real-world run on Apache Superset's frontend (webpack 5, ~260 direct dependencies).
# Run in a Wolfi container with network, e.g. on a workstation:
#   docker run --rm -v "$PWD":/repo:ro -v /var/tmp/superset:/work cgr.dev/chainguard/wolfi-base \
#     sh /repo/test/bigproject/superset.sh /work [tag]
# Writes /work/results/*.md and logs; the build runs several times, so expect a long run.
set -eu
W=$1; TAG=${2:-6.1.0}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
R=$W/results; mkdir -p "$R"
apk add -q nodejs-22 npm git syft >/dev/null

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
# what superset's "build" script runs, but without cross-env replacing NODE_OPTIONS
webpack_build() { # name extra-node-options
  rm -rf "$OUT"
  echo "== $1"
  NODE_ENV=production BABEL_ENV=production NODE_OPTIONS="--max_old_space_size=8192 $MEASURE $2" \
    ./node_modules/.bin/webpack --mode production > "$R/$1.log" 2>&1 || { echo "build $1 FAILED, see $R/$1.log"; return 1; }
  grep '\[measure\].*script=webpack' "$R/$1.log" | tail -1
}

{
  echo "# Superset $TAG frontend"
  echo
  echo "node $(node -v), npm $(npm -v), $(./node_modules/.bin/webpack --version | tr '\n' ' ')"
  echo
  echo "## Build cost (main webpack process)"
  echo
  echo '```'
  webpack_build baseline ""
  webpack_build bundle-lockfile "$TOOL"
  echo '```'
  echo
  locks=$(find "$OUT" -path '*bundle-lockfile/package-lock.json' | wc -l)
  pkgs=$(cat $(find "$OUT" -path '*bundle-lockfile/package-lock.json') | grep -c '"version"' || true)
  echo "bundle-lockfile: $locks lockfile(s), $pkgs package entries"
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
  webpack_build compare "$COMPARE"
  echo '```'
  echo
  node "$REPO/test/compare/report.cjs" "$OUT" "bundle-lockfile vs. CycloneDX webpack plugin"
  echo "## npm run build (the project's own script)"
  echo
  rm -rf "$OUT"
  NODE_OPTIONS="$TOOL" npm run build > "$R/npm-run-build.log" 2>&1 || echo "npm run build FAILED, see $R/npm-run-build.log"
  echo "lockfiles written: $(find "$OUT" -path '*bundle-lockfile/package-lock.json' | wc -l) (the script sets NODE_OPTIONS itself via cross-env, replacing the --require)"
} 2>&1 | tee "$R/superset.md"
