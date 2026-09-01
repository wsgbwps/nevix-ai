.PHONY: dev build lint server postgres postgres-down docker-ready test-e2e test-e2e-smoke test-identity-integration harness-test setup

dev:
	pnpm dev

build:
	pnpm build

lint:
	pnpm lint

# Local server run (scripts/dev/dev-server.sh): sources server/.env.local when
# present — it must define MIGRATION_DATABASE_URL (DDL credential) and
# DATABASE_URL (identity_app runtime credential) — then runs the Go server on
# plaintext :8080. With caddy installed it also terminates TLS on
# https://127.0.0.1:8443 (internal CA) and may start the fake Kapon sidecar;
# see scripts/dev/README.md.
server:
	./scripts/dev/dev-server.sh

# Idempotent local-development PostgreSQL. Data persists in the
# nevix-dev-postgres-data volume across make postgres-down/up; reset the
# database by also removing that volume. server/.env.local credentials must
# match (see README 本地开发启动顺序).
#
# Also provisions the identity_app LOGIN role (password dev) when missing so a
# volume reset needs no manual step; an existing role is adopted untouched —
# migrations never reset credentials and neither does this target.
postgres:
	@if docker container inspect nevix-dev-postgres >/dev/null 2>&1; then \
		docker start nevix-dev-postgres >/dev/null; \
	else \
		docker run -d --name nevix-dev-postgres \
			-p 127.0.0.1:5432:5432 \
			-e POSTGRES_PASSWORD=dev \
			-v nevix-dev-postgres-data:/var/lib/postgresql/data \
			postgres:17.5-alpine >/dev/null; \
	fi
	@ready=0; for i in $$(seq 1 30); do \
		if docker exec nevix-dev-postgres pg_isready -U postgres -d postgres >/dev/null 2>&1; then ready=1; break; fi; \
		sleep 1; \
	done; \
	[ "$$ready" = 1 ] || { echo "error: nevix-dev-postgres 未在 30s 内就绪" >&2; exit 1; }
	@if docker exec nevix-dev-postgres psql -U postgres -d postgres -tAc \
		"select 1 from pg_roles where rolname='identity_app'" | grep -q 1; then \
		echo "ok - identity_app 角色已存在，保持不动"; \
	else \
		docker exec nevix-dev-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
			-c "CREATE ROLE identity_app LOGIN PASSWORD 'dev'" \
			&& echo "ok - identity_app 角色已创建（密码 dev）"; \
	fi
	@echo "ok - nevix-dev-postgres ready on 127.0.0.1:5432 (postgres superuser password: dev)"

postgres-down: docker-ready
	@if docker container inspect nevix-dev-postgres >/dev/null 2>&1; then \
		docker rm -f nevix-dev-postgres; \
	else \
		echo "ok - nevix-dev-postgres 不存在，无需清理"; \
	fi

docker-ready:
	@docker info >/dev/null 2>&1 || { echo "error: Docker 未运行 —— 测试栈需要它拉起 PostgreSQL；先启动 Docker Desktop 再重试" >&2; exit 1; }

# Desktop E2E suites: the harness builds a temporary Go server and starts its
# own throwaway PostgreSQL container; only the Docker daemon must be running.
test-e2e-smoke: docker-ready
	pnpm --filter @nevix/desktop test:e2e:smoke

test-e2e: docker-ready
	pnpm --filter @nevix/desktop test:e2e

test-identity-integration: docker-ready
	./scripts/test-identity-integration.sh

# Creation Module integration: real PostgreSQL + MinIO, zero skips, sentinels
# (issue #156). Also runs the short file-stream smoke.
test-creation-integration: docker-ready
	./scripts/test-creation-integration.sh

harness-test:
	node --test .agents/skills/code-review/tests/review-lifecycle.test.mjs scripts/tests/classify-ci-changes.test.mjs scripts/tests/post-merge-dedup.test.mjs scripts/tests/deploy-stack.test.mjs .pi/tests/pi-hooks.test.mjs

setup:
	pnpm install
	go install golang.org/x/tools/cmd/goimports@latest
	go install golang.org/x/tools/gopls@latest
	mkdir -p ~/.config/husky
	test -f ~/.config/husky/init.sh || echo 'export PATH="/usr/local/bin:/opt/homebrew/bin:$$HOME/go/bin:$$PATH"' > ~/.config/husky/init.sh
