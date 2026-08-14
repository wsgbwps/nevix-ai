.PHONY: dev build lint server server-mailpit supabase test-identity-integration harness-test land setup

dev:
	pnpm dev

build:
	pnpm build

lint:
	pnpm lint

server:
	cd server && if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi; go run ./cmd/server

server-mailpit:
	@set -eu; identity_app_password="$$(openssl rand -hex 32)"; \
		printf "ALTER ROLE identity_app PASSWORD '%s';\n" "$$identity_app_password" | docker exec -i supabase_db_nevix-ai psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null; \
		cd server && if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi; \
		DATABASE_URL="postgresql://identity_app:$${identity_app_password}@127.0.0.1:54322/postgres?sslmode=disable" SMTP_HOST=127.0.0.1 SMTP_PORT=54325 SMTP_USER=mailpit SMTP_PASSWORD=mailpit SMTP_FROM=identity@nevix.test OUTBOX_RETRY_DELAYS=1s,2s,3s,4s,5s go run ./cmd/server

supabase:
	pnpm exec supabase start

test-identity-integration:
	./scripts/test-identity-integration.sh

harness-test:
	node --test .codex/hooks/final-state-evidence.test.mjs .agents/skills/code-review/tests/review-lifecycle.test.mjs scripts/tests/classify-ci-changes.test.mjs scripts/tests/land.test.mjs

land:
	node scripts/land.mjs land

setup:
	pnpm install
	go install golang.org/x/tools/cmd/goimports@latest
	go install golang.org/x/tools/gopls@latest
	mkdir -p ~/.config/husky
	test -f ~/.config/husky/init.sh || echo 'export PATH="/usr/local/bin:/opt/homebrew/bin:$$HOME/go/bin:$$PATH"' > ~/.config/husky/init.sh
