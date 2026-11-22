.PHONY: help install typecheck lint format hygiene build test ci constraints docker-smoke

help:
	@echo "make install    install exact dependencies from package-lock.json"
	@echo "make typecheck  type-check every workspace"
	@echo "make lint       ESLint plus the Prettier check"
	@echo "make format     rewrite files in the Prettier style"
	@echo "make hygiene    repo rules: names, planning refs, artifacts, pinned actions and images, lockfile"
	@echo "make build      build the dashboard into frontend/out (also type-checks the .tsx files)"
	@echo "make test       run every workspace's tests"
	@echo "make ci         every gate CI runs, in the same order"
	@echo "make constraints  the CONSTRAINTS.md checks: floor, coverage, architecture, pages (needs make build; CI's constraints job)"
	@echo "make docker-smoke  build the image and check the running container (needs Docker; CI runs it too)"

install:
	npm ci

typecheck:
	npm run typecheck

lint:
	npm run lint
	npm run format:check

format:
	npm run format

hygiene:
	npm run hygiene

build:
	npm run build

test:
	npm test

ci: lint typecheck build hygiene test

constraints:
	npm run check:floor
	npm run check:coverage
	npm run check:arch
	npm run check:pages

docker-smoke:
	npm run docker:smoke
