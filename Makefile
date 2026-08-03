.PHONY: dev build lint server setup

dev:
	pnpm dev

build:
	pnpm build

lint:
	pnpm lint

server:
	cd server && if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi; go run ./cmd/server

setup:
	pnpm install
	go install golang.org/x/tools/cmd/goimports@latest
	go install golang.org/x/tools/gopls@latest
	mkdir -p ~/.config/husky
	test -f ~/.config/husky/init.sh || echo 'export PATH="/usr/local/bin:/opt/homebrew/bin:$$HOME/go/bin:$$PATH"' > ~/.config/husky/init.sh
