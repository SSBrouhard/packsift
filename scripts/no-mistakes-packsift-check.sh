#!/bin/sh

# Optional PackSift evidence producer for no-mistakes and other agent pipelines.
# Evidence is written to stdout. PackSift's exit status is propagated only when
# the tool cannot complete an analysis; reported package drift is not a failure.

set -u

usage() {
  cat <<'EOF'
Usage:
  scripts/no-mistakes-packsift-check.sh [dependencies] [--base <ref>] [--json]
  scripts/no-mistakes-packsift-check.sh release [dir-or-tgz] [--json]

Environment:
  PACKSIFT_BIN       PackSift executable to invoke (default: packsift)
  PACKSIFT_BASE_REF  Dependency comparison base when --base and
                     GITHUB_BASE_REF are unset (default: main)
EOF
}

mode="dependencies"
base_ref="${PACKSIFT_BASE_REF:-${GITHUB_BASE_REF:-main}}"
packsift_bin="${PACKSIFT_BIN:-packsift}"
json_flag=""
release_input=""

if [ "${1:-}" = "dependencies" ] || [ "${1:-}" = "release" ]; then
  mode="$1"
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      if [ "$#" -lt 2 ]; then
        echo "PackSift evidence error: --base requires a git ref" >&2
        usage >&2
        exit 2
      fi
      base_ref="$2"
      shift 2
      ;;
    --json)
      json_flag="--json"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "PackSift evidence error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ "$mode" != "release" ] || [ -n "$release_input" ]; then
        echo "PackSift evidence error: unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      release_input="$1"
      shift
      ;;
  esac
done

run_packsift() {
  if [ -n "$json_flag" ]; then
    "$packsift_bin" "$@" "$json_flag"
  else
    "$packsift_bin" "$@"
  fi
}

announce() {
  if [ -n "$json_flag" ]; then
    echo "$@" >&2
  else
    echo "$@"
  fi
}

if [ "$mode" = "release" ]; then
  if [ -z "$release_input" ]; then
    release_input="."
  fi
  announce "PackSift pre-publish evidence: pack-check $release_input"
  run_packsift pack-check "$release_input"
  exit $?
fi

if git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null; then
  resolved_base="$base_ref"
elif git rev-parse --verify --quiet "origin/$base_ref^{commit}" >/dev/null; then
  resolved_base="origin/$base_ref"
else
  echo "PackSift evidence error: cannot resolve base ref '$base_ref' or 'origin/$base_ref'" >&2
  exit 2
fi

merge_base=$(git merge-base "$resolved_base" HEAD) || {
  echo "PackSift evidence error: cannot find merge base for '$resolved_base' and HEAD" >&2
  exit 2
}

changed_paths=$(git diff --name-only --diff-filter=ACDMRT "$merge_base" --) || {
  echo "PackSift evidence error: cannot read changes from '$merge_base'" >&2
  exit 2
}

lockfiles=""
package_json_changed=false
package_json_removed=false
relevant_change=false
old_ifs=$IFS
IFS='
'
for path in $changed_paths; do
  case "$path" in
    package-lock.json|*/package-lock.json|npm-shrinkwrap.json|*/npm-shrinkwrap.json|pnpm-lock.yaml|*/pnpm-lock.yaml|yarn.lock|*/yarn.lock)
      relevant_change=true
      lockfiles="${lockfiles}${path}
"
      ;;
    package.json|*/package.json)
      relevant_change=true
      package_json_changed=true
      if [ ! -f "$path" ]; then
        package_json_removed=true
      fi
      ;;
  esac
done
IFS=$old_ifs

ran_check=false
IFS='
'
for lockfile in $lockfiles; do
  [ -n "$lockfile" ] || continue
  if ! git cat-file -e "$merge_base:$lockfile" 2>/dev/null; then
    announce "PackSift dependency evidence: $lockfile is new; no prior lockfile exists at $merge_base"
    continue
  fi
  if [ ! -f "$lockfile" ]; then
    announce "PackSift dependency evidence: $lockfile was removed; no prior-to-current comparison is available"
    continue
  fi

  announce "PackSift dependency evidence: batch $merge_base:$lockfile -> $lockfile"
  ran_check=true
  run_packsift batch "$merge_base:$lockfile" "$lockfile"
  status=$?
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
done
IFS=$old_ifs

if [ "$ran_check" = false ]; then
  if [ "$package_json_removed" = true ]; then
    announce "PackSift dependency evidence: package.json was removed; no dependency comparison can be inferred."
  elif [ "$package_json_changed" = true ]; then
    announce "PackSift dependency evidence: package.json changed, but no existing changed lockfile can be compared."
    announce "Use a published transition for a known dependency: packsift <name>@<old> <name>@<new>"
  elif [ "$relevant_change" = false ]; then
    announce "PackSift dependency evidence: no package.json or supported lockfile changes detected."
  fi
fi

exit 0
