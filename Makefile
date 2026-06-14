.PHONY: dev build lint server

dev:
	pnpm dev

build:
	pnpm build

lint:
	pnpm lint

server:
	cd server && go run .
