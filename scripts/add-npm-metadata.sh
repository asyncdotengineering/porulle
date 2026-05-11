#!/usr/bin/env bash
# Inject npm publishing metadata into every publishable package.json.
# Idempotent — safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOMEPAGE="https://porulle-docs.vercel.app"
BUGS_URL="https://github.com/asyncdotengineering/porulle/issues"
GIT_URL="git+https://github.com/asyncdotengineering/porulle.git"

clean_desc() {
  # Strip markdown links [text](url) → text, strip backticks, collapse whitespace, truncate.
  echo "$1" \
    | sed -E 's/\[([^]]+)\]\([^)]+\)/\1/g' \
    | sed 's/`//g' \
    | tr -s ' \t' ' ' \
    | head -c 200
}

cd "$REPO_ROOT"

count=0
while IFS= read -r pkg; do
  dir=$(dirname "$pkg")
  rel=${dir#"$REPO_ROOT"/}
  priv=$(jq -r '.private // false' "$pkg")
  [ "$priv" = "true" ] && continue
  name=$(jq -r '.name' "$pkg")

  desc_raw=""
  if [ -f "$dir/README.md" ]; then
    desc_raw=$(awk '/^[A-Za-z`]/ && !/^#/ {print; exit}' "$dir/README.md")
  fi
  desc=$(clean_desc "$desc_raw")
  [ -z "$desc" ] && desc="$name — part of the Porulle headless commerce framework."

  jq \
    --arg desc "$desc" \
    --arg homepage "$HOMEPAGE" \
    --arg bugs "$BUGS_URL" \
    --arg gitUrl "$GIT_URL" \
    --arg dir "$rel" \
    '. * {
      description: $desc,
      homepage: $homepage,
      bugs: { url: $bugs },
      repository: { type: "git", url: $gitUrl, directory: $dir },
      author: "Porulle contributors",
      license: "MIT"
    }' "$pkg" > "$pkg.tmp"
  mv "$pkg.tmp" "$pkg"
  echo "✓ $name"
  count=$((count + 1))
done < <(find packages -maxdepth 4 -name package.json -not -path "*/node_modules/*" -not -path "*/templates/starter/*")

echo
echo "Updated $count publishable package.json files."
