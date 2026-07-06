.PHONY: dev test build publish

dev:
	pnpm run dev

test:
	pnpm test

build:
	pnpm run build

publish: build
	pnpm login && pnpm publish --access public
