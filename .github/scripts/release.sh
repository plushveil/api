#!/usr/bin/env bash

set -euo pipefail

: "${TAG:?TAG is required}"
: "${SOURCE:?SOURCE is required}"

# Validate semantic version tag.
if [[ ! "$TAG" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Tag must be a semantic version in the form vMAJOR.MINOR.PATCH"
  exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

TAG_MAJOR="v${MAJOR}"
TAG_MINOR="v${MAJOR}.${MINOR}"
TAG_PATCH="v${MAJOR}.${MINOR}.${PATCH}"

# Resolve the source to an exact commit.
if git rev-parse --verify --quiet "$SOURCE^{commit}" >/dev/null; then
  COMMIT="$(git rev-parse "$SOURCE^{commit}")"
elif git rev-parse --verify --quiet "origin/$SOURCE^{commit}" >/dev/null; then
  COMMIT="$(git rev-parse "origin/$SOURCE^{commit}")"
else
  echo "Could not resolve source: $SOURCE"
  exit 1
fi

echo "Source: $SOURCE"
echo "Commit: $COMMIT"

# Every released version including this one, oldest first. A moving tag may only be advanced when
# this release is the newest thing underneath it, and that has to be judged against the whole list:
# checking only the next version up would drag v1 back to v1.2.3 when v1.4.0 already exists.
mapfile -t RELEASED < <(
  {
    git ls-remote --tags origin 'refs/tags/v*' | sed 's#.*refs/tags/##; s#\^{}$##'
    echo "$TAG_PATCH"
  } | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -u
)

# Is this release the newest of the versions matching $1?
is_newest() {
  [[ "$(printf '%s\n' "${RELEASED[@]}" | grep -E "$1" | tail -n 1)" == "$TAG_PATCH" ]]
}

# The exact version is the only one npm can accept, so it is the only tag that gets a workflow run.
# The moving tags are Git pointers and Docker aliases; they ride along as `docker_tags` rather than
# triggering their own build, which is what made `npm version 1` fail.
DOCKER_TAGS=("${MAJOR}.${MINOR}.${PATCH}")

git tag -f "$TAG_PATCH" "$COMMIT"
git push --force origin "$TAG_PATCH"
echo "Upserted $TAG_PATCH"

if is_newest "^v${MAJOR}\.${MINOR}\."; then
  git tag -f "$TAG_MINOR" "$COMMIT"
  git push --force origin "$TAG_MINOR"
  DOCKER_TAGS+=("${MAJOR}.${MINOR}")
  echo "Upserted $TAG_MINOR"
else
  echo "Skipping $TAG_MINOR because a newer patch already exists"
fi

if is_newest "^v${MAJOR}\."; then
  git tag -f "$TAG_MAJOR" "$COMMIT"
  git push --force origin "$TAG_MAJOR"
  DOCKER_TAGS+=("${MAJOR}")
  echo "Upserted $TAG_MAJOR"
else
  echo "Skipping $TAG_MAJOR because a newer minor already exists"
fi

# `latest` follows the newest release overall, so re-releasing an old patch must not claim it.
if is_newest '^v'; then
  DOCKER_TAGS+=("latest")
else
  echo "Skipping latest because a newer version already exists"
fi

IFS=','
echo "Publishing $TAG_PATCH with image tags: ${DOCKER_TAGS[*]}"
gh workflow run publish.yml --ref "$TAG_PATCH" \
  -f tag="$TAG_PATCH" -f docker_tags="${DOCKER_TAGS[*]}"
