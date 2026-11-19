#!/bin/sh
# Prepare a release: sets the version in config.json, turns "## [Unreleased]" in changelog.md into the
# new version, commits, tags, and moves the 'release' branch (what MeshCentral downloads) to the new tag.
#   usage: sh release.sh 0.1.9        then: git push origin master release --tags
set -eu
V="${1:?usage: sh release.sh <version>   e.g. 0.1.5}"
echo "$V" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "Version must look like 1.2.3"; exit 1; }
git rev-parse -q --verify "refs/tags/$V" >/dev/null && { echo "Tag $V already exists"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first"; exit 1; }

sed -i.bak -E "s#(\"version\": *\")[^\"]*\"#\1$V\"#" config.json
# MeshCentral's Upgrade downloads from the downloadUrl saved for the *installed* version, so it must not change
# between releases: it always points at the 'release' branch, which this script moves to the new tag.
grep -q '"downloadUrl": *"[^"]*/archive/refs/heads/release.zip"' config.json || { echo "config.json downloadUrl must point at archive/refs/heads/release.zip"; exit 1; }
if grep -q '^## \[Unreleased\]' changelog.md; then
  sed -i.bak -E "s/^## \[Unreleased\].*/## [$V] - $(date +%Y-%m-%d)/" changelog.md
fi
rm -f config.json.bak changelog.md.bak
grep -q "## \[$V\]" changelog.md || { echo "Warning: changelog.md has no entry for $V"; }

git add config.json changelog.md
git commit -qm "Release $V"
git tag -a "$V" -m "ScriptTask $V"
git branch -f release "$V"
echo "Release $V ready:"
grep -E '"(version|downloadUrl)"' config.json
echo "Now run:  git push origin master release --tags"
echo "Then in MeshCentral: My Server > Plugins > Check for updates > Upgrade"
