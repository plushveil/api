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

NEXT_MINOR="v${MAJOR}.$((MINOR + 1))"
NEXT_PATCH="v${MAJOR}.${MINOR}.$((PATCH + 1))"

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
echo "Tags:"
echo "  $TAG_MAJOR"
echo "  $TAG_MINOR"
echo "  $TAG_PATCH"

# Update major tag unless the next minor already exists.
if git ls-remote --exit-code --tags origin "refs/tags/$NEXT_MINOR" >/dev/null 2>&1; then
  echo "Skipping $TAG_MAJOR because $NEXT_MINOR already exists"
else
  git tag -f "$TAG_MAJOR" "$COMMIT"
  git push --force origin "$TAG_MAJOR"
  echo "Upserted $TAG_MAJOR"
  gh workflow run publish.yml --ref "$TAG_MAJOR" -f tag="$TAG_MAJOR"
fi

# Update minor tag unless the next patch already exists.
if git ls-remote --exit-code --tags origin "refs/tags/$NEXT_PATCH" >/dev/null 2>&1; then
  echo "Skipping $TAG_MINOR because $NEXT_PATCH already exists"
else
  git tag -f "$TAG_MINOR" "$COMMIT"
  git push --force origin "$TAG_MINOR"
  echo "Upserted $TAG_MINOR"
  gh workflow run publish.yml --ref "$TAG_MINOR" -f tag="$TAG_MINOR"
fi

# Always update the exact patch tag.
git tag -f "$TAG_PATCH" "$COMMIT"
git push --force origin "$TAG_PATCH"
echo "Upserted $TAG_PATCH"
gh workflow run publish.yml --ref "$TAG_PATCH" -f tag="$TAG_PATCH"
