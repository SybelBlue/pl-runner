SHELL := /bin/bash

# `make publish patch` passes the release mode as an extra goal; see the no-op
# targets below.
RELEASE_MODE := $(filter current major minor patch,$(MAKECMDGOALS))

.PHONY: dev test build publish current major minor patch

dev:
	pnpm run dev

test:
	pnpm test

build:
	pnpm run build

publish:
	@if [ "$(words $(RELEASE_MODE))" != 1 ]; then \
		echo "usage: make publish current|patch|minor|major" >&2; exit 2; \
	fi
	@if [ "$$(git rev-parse --abbrev-ref HEAD)" != main ]; then \
		echo "error: publish must run from main" >&2; exit 2; \
	fi
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "error: publish requires a clean working tree" >&2; exit 2; \
	fi
	git fetch --quiet origin main
	@git merge-base --is-ancestor origin/main HEAD || { \
		echo "error: main is behind or has diverged from origin/main" >&2; exit 2; \
	}
	pnpm run build
	pnpm login
	@if [ "$(RELEASE_MODE)" != current ]; then \
		npm version "$(RELEASE_MODE)"; \
	fi
	@version=$$(node -p "require('./package.json').version"); \
		tag="v$$version"; \
		if git rev-parse -q --verify "refs/tags/$$tag" >/dev/null; then \
			if [ "$$(git rev-list -n 1 "$$tag")" != "$$(git rev-parse HEAD)" ]; then \
				echo "error: $$tag does not point at HEAD" >&2; exit 2; \
			fi; \
		else \
			git tag -a "$$tag" -m "$$tag"; \
		fi; \
		git push --atomic origin main "$$tag"
	pnpm publish --access public

# Release-mode words for `make publish <mode>`; they do nothing on their own.
current major minor patch:
	@:
