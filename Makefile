.PHONY: dev build lint server supabase test-identity-integration harness-test setup

dev:
	pnpm dev

build:
	pnpm build

lint:
	pnpm lint

server:
	cd server && if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi; go run ./cmd/server

# Local server run: expects .env.local in server/ to define MIGRATION_DATABASE_URL
# (DDL credential) and DATABASE_URL (identity_app runtime credential).

supabase:
	pnpm exec supabase start

test-identity-integration:
	./scripts/test-identity-integration.sh

harness-test:
	node --test .agents/skills/code-review/tests/review-lifecycle.test.mjs scripts/tests/classify-ci-changes.test.mjs scripts/tests/post-merge-dedup.test.mjs .pi/tests/pi-hooks.test.mjs

setup:
	pnpm install
	go install golang.org/x/tools/cmd/goimports@latest
	go install golang.org/x/tools/gopls@latest
	mkdir -p ~/.config/husky
	test -f ~/.config/husky/init.sh || echo 'export PATH="/usr/local/bin:/opt/homebrew/bin:$$HOME/go/bin:$$PATH"' > ~/.config/husky/init.sh
