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
json_tmp_dir=""
json_result_count=0

for argument do
  if [ "$argument" = "--json" ]; then
    json_flag="--json"
    break
  fi
done

if [ -n "$json_flag" ]; then
  json_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/packsift-no-mistakes.XXXXXX") || {
    echo "PackSift evidence error: cannot create JSON output buffer" >&2
    exit 2
  }
  : > "$json_tmp_dir/events"
  trap 'rm -rf "$json_tmp_dir"' EXIT
fi

emit_json_envelope() {
  [ -n "$json_flag" ] || return 0
  node - "$json_tmp_dir" "$mode" "$release_input" "$base_ref" "${1:-0}" "${2:-}" "${3:-}" <<'NODE'
const { readdirSync, readFileSync } = require("node:fs");

const [directory, mode, input, base, exitCode, errorType, errorMessage] = process.argv.slice(2);
const resultFiles = readdirSync(directory)
  .filter((name) => name.startsWith("result."))
  .sort((left, right) => Number(left.slice(7)) - Number(right.slice(7)));
const results = [];
const errors = [];

for (const resultFile of resultFiles) {
  const raw = readFileSync(`${directory}/${resultFile}`, "utf8").trim();
  if (!raw) continue;
  try {
    results.push(JSON.parse(raw));
  } catch {
    errors.push({ type: "invalid-json", source: resultFile });
  }
}

const events = readFileSync(`${directory}/events`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((event) => {
    const [type, path, base] = event.split("\t");
    return { type, ...(path ? { path } : {}), ...(base ? { base } : {}) };
  });
if (Number(exitCode) !== 0) {
  const error = { type: errorType || "packsift", exitCode: Number(exitCode) };
  if (errorMessage) error.message = errorMessage;
  errors.push(error);
}

const envelope = {
  version: 1,
  mode,
  ...(mode === "release" ? { input } : { base }),
  results,
  events,
  errors,
};
process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
NODE
}

fail_with_error() {
  status="$1"
  error_type="$2"
  error_message="$3"
  echo "$error_message" >&2
  if [ -n "$json_flag" ]; then
    emit_json_envelope "$status" "$error_type" "$error_message"
  fi
  exit "$status"
}

fail_with_usage() {
  status="$1"
  error_message="$2"
  echo "$error_message" >&2
  usage >&2
  if [ -n "$json_flag" ]; then
    emit_json_envelope "$status" usage "$error_message"
  fi
  exit "$status"
}

record_json_event() {
  if [ -n "$json_flag" ]; then
    printf '%s\t%s\t%s\n' "${1:-}" "${2:-}" "${3:-}" >> "$json_tmp_dir/events"
  fi
}

announce() {
  if [ -n "$json_flag" ]; then
    echo "$@" >&2
  else
    echo "$@"
  fi
}

if [ "${1:-}" = "dependencies" ] || [ "${1:-}" = "release" ]; then
  mode="$1"
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      if [ "$#" -lt 2 ]; then
        fail_with_usage 2 "PackSift evidence error: --base requires a git ref"
      fi
      base_ref="$2"
      shift 2
      ;;
    --json)
      json_flag="--json"
      shift
      ;;
    -h|--help)
      if [ -n "$json_flag" ]; then
        usage >&2
        record_json_event help
        emit_json_envelope 0
      else
        usage
      fi
      exit 0
      ;;
    -*)
      fail_with_usage 2 "PackSift evidence error: unknown option: $1"
      ;;
    *)
      if [ "$mode" != "release" ] || [ -n "$release_input" ]; then
        fail_with_usage 2 "PackSift evidence error: unexpected argument: $1"
      fi
      release_input="$1"
      shift
      ;;
  esac
done

run_packsift() {
  if [ -n "$json_flag" ]; then
    json_result_count=$((json_result_count + 1))
    "$packsift_bin" "$@" "$json_flag" > "$json_tmp_dir/result.$json_result_count"
  else
    "$packsift_bin" "$@"
  fi
}

if [ "$mode" = "release" ]; then
  if [ -z "$release_input" ]; then
    release_input="."
  fi
  announce "PackSift pre-publish evidence: pack-check $release_input"
  record_json_event "pre-publish" "$release_input"
  run_packsift pack-check "$release_input"
  status=$?
  emit_json_envelope "$status"
  exit "$status"
fi

if git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null; then
  resolved_base="$base_ref"
elif git rev-parse --verify --quiet "origin/$base_ref^{commit}" >/dev/null; then
  resolved_base="origin/$base_ref"
else
  fail_with_error 2 git "PackSift evidence error: cannot resolve base ref '$base_ref' or 'origin/$base_ref'"
fi

merge_base=$(git merge-base "$resolved_base" HEAD) || fail_with_error 2 git "PackSift evidence error: cannot find merge base for '$resolved_base' and HEAD"

changed_paths=$(git diff --name-only --diff-filter=ACDMRT "$merge_base" --) || fail_with_error 2 git "PackSift evidence error: cannot read changes from '$merge_base'"

lockfiles=""
package_json_changed=false
package_json_removed=false
package_json_paths=""
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
      package_json_paths="${package_json_paths}${path}
"
      if [ ! -f "$path" ]; then
        package_json_removed=true
      fi
      ;;
  esac
done
IFS=$old_ifs

old_ifs=$IFS
IFS='
'
for package_json_path in $package_json_paths; do
  [ -n "$package_json_path" ] || continue
  if [ -f "$package_json_path" ]; then
    record_json_event "package-json-changed" "$package_json_path"
  else
    record_json_event "removed-package-json" "$package_json_path"
  fi
done
IFS=$old_ifs

ran_check=false
IFS='
'
for lockfile in $lockfiles; do
  [ -n "$lockfile" ] || continue
  if ! git cat-file -e "$merge_base:$lockfile" 2>/dev/null; then
    announce "PackSift dependency evidence: $lockfile is new; no prior lockfile exists at $merge_base"
    record_json_event "new-lockfile" "$lockfile" "$merge_base"
    continue
  fi
  if [ ! -f "$lockfile" ]; then
    announce "PackSift dependency evidence: $lockfile was removed; no prior-to-current comparison is available"
    record_json_event "removed-lockfile" "$lockfile"
    continue
  fi

  announce "PackSift dependency evidence: batch $merge_base:$lockfile -> $lockfile"
  record_json_event "batch" "$lockfile" "$merge_base"
  ran_check=true
  run_packsift batch "$merge_base:$lockfile" "$lockfile"
  status=$?
  if [ "$status" -ne 0 ]; then
    emit_json_envelope "$status"
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
    record_json_event "no-changes"
  fi
fi

emit_json_envelope 0
exit 0
