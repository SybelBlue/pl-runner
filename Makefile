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
	pnpm run build
	pnpm login
	@if [ "$(RELEASE_MODE)" != current ]; then \
		npm version "$(RELEASE_MODE)"; \
	fi
	pnpm publish --access public

# Release-mode words for `make publish <mode>`; they do nothing on their own.
current major minor patch:
	@:
