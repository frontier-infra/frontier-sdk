# __PROJECT_NAME__

A small Frontier Infra governed-worker starter. It includes:

- React/Vite operator UI
- Node HTTP server using `@frontier-infra/harness-kit`
- OpenAI-compatible configuration surface
- AVL discovery document at `/.well-known/avl.json`
- local PostgreSQL, Redis, and S3-compatible compose services
- production-reference compose and env examples

```sh
cp .env.example .env
npm install
npm run dev
```

You can use npm, pnpm, or yarn. The generated scripts avoid package-manager
specific helpers.

## Local Services

```sh
docker compose -f docker-compose.local.yml up -d
```

The local compose stack is for development convenience. The production-reference
files are examples of configuration shape only; adapt networking, secrets,
persistence, backups, observability, and access controls before deploying.
