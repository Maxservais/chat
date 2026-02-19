# Architecture Notes

## Our Setup

Single Cloudflare Worker that handles everything:

```
src/
├── server/
│   ├── entry.ts              ← Cloudflare Worker entry (main)
│   │   ├── routeAgentRequest()  → /agents/* → ChatAgent Durable Object (WebSocket)
│   │   └── TanStack Start handler → everything else → SSR pages, server functions
│   ├── agent.ts              ← ChatAgent Durable Object class (tools, system prompt, ICS generation)
│   ├── ethcc-api.ts          ← EthCC tRPC API client, KV caching, search/filter helpers
│   ├── middleware/            ← TanStack Start server middleware (future)
│   └── functions/             ← TanStack Start server functions (future)
├── components/
│   ├── chat/
│   │   ├── AgentChat.tsx      ← Main chat UI (client-only, ssr: false)
│   │   └── ToolPartView.tsx   ← Tool execution state rendering (search summaries, calendar download, approvals)
│   ├── DefaultCatchBoundary.tsx
│   ├── NotFound.tsx
│   └── Header.tsx
├── routes/
│   ├── __root.tsx
│   ├── index.tsx
│   └── chat.tsx               ← ssr: false (needs WebSocket/browser APIs)
├── utils/
│   └── seo.ts
├── router.tsx
└── styles.css
```

- **TanStack Start** handles routing, SSR, server functions
- **ChatAgent** Durable Object is exported from `server/entry.ts`
- **Workers AI** binding configured in `wrangler.jsonc`, routed through **AI Gateway** (`ethcc-planner`) for observability/analytics
- **KV** (`ETHCC_CACHE`) caches EthCC API responses (1hr TTL)
- **Agent tools**: `searchTalks` (with pagination), `getTalkDetails`, `getConferenceInfo`, `generateCalendarFile` (.ics export)
- Server code lives in `src/server/`, client code in `src/components/` and `src/routes/`
- Simple, single deploy, single worker

## Backpine SaaS Kit (Reference)

Repository: https://github.com/backpine/saas-kit/tree/main/apps

They split into two Cloudflare Workers in a pnpm monorepo:

```
apps/
├── user-application/     → TanStack Start (frontend + SSR + auth)
└── data-service/         → Hono (backend: Durable Objects, Workflows, heavy processing)

packages/
└── data-ops/             → shared library (DB setup, auth, Zod schemas, queries)
```

### user-application (Frontend Worker)

- **Framework**: TanStack Start + Cloudflare Vite Plugin
- **Export**: plain `{ fetch }` handler
- **Responsibilities**: SSR, React UI, auth (better-auth), server functions
- **Database**: connects directly to PlanetScale via `@repo/data-ops` (bundled at build time)
- **No Durable Objects or Workflows** — delegates those to data-service

### data-service (Backend Worker)

- **Framework**: Hono
- **Export**: `WorkerEntrypoint` class (enables service bindings + RPC, not just HTTP)
- **Responsibilities**: Durable Objects, Workflows, background jobs, heavy data processing
- **Designed to be called** by other workers via service bindings

### How they communicate

Via Cloudflare [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) (not HTTP over the internet — it's in-datacenter RPC):

```jsonc
// user-application/wrangler.jsonc
"services": [{ "binding": "DATA_SERVICE", "service": "saas-kit-data-service" }]
```

```ts
// Then in user-application server functions:
env.DATA_SERVICE.fetch(new Request("https://internal/some-endpoint"))
// or direct RPC:
env.DATA_SERVICE.someMethod(args)
```

### Shared code (packages/data-ops)

Not a runtime service — it's a build-time dependency bundled into both workers:
- `@repo/data-ops/auth/server` — auth setup (better-auth + Drizzle)
- `@repo/data-ops/database/setup` — PlanetScale connection
- `@repo/data-ops/zod-schema/*` — shared validation schemas

Both workers import from it. Root deploy scripts ensure it's built first:
```
"deploy:user-application": "pnpm run build:data-ops && pnpm run --filter user-application deploy"
```

## Why Our Setup is Different

| | Our app | Backpine |
|---|---|---|
| **Workers** | 1 (does everything) | 2 (frontend + backend) |
| **Durable Objects** | In the same worker | In data-service worker |
| **Communication** | Direct (same process) | Service bindings (cross-worker RPC) |
| **Complexity** | Simpler | More separation of concerns |
| **Deploy** | Single `wrangler deploy` | Two separate deploys |

Our approach is simpler and works well when the backend is primarily the AI agent. The backpine approach makes sense when:

- Backend grows complex (many DOs, Workflows, queues, cron triggers)
- You want to deploy/scale backend independently from frontend
- Multiple frontends need to share the same backend services
- Different teams own frontend vs backend

## If We Need to Evolve

To move toward the backpine pattern:

1. **Create a second worker** (e.g. `apps/data-service/`) with Hono + `WorkerEntrypoint`
2. **Move ChatAgent** and future DOs/Workflows into that worker
3. **Add service binding** in our `wrangler.jsonc` to connect the two
4. **Remove DO exports** from `server/entry.ts` — TanStack Start worker becomes pure frontend
5. Consider a **shared package** for types, schemas, validation (like their `data-ops`)

For now, the single-worker setup keeps things simple and there's no reason to split until complexity demands it.
