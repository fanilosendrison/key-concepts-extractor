# key-concepts-extractor

CLI tool to extract key concepts from text via multiple LLM providers (Anthropic, OpenAI, Google Gemini), merge results, and expose a web tracking interface.

## Prerequisites

- **Node.js** >= 22.0.0 ([download](https://nodejs.org/))
- **pnpm** >= 10 — enable via corepack:
  ```bash
  corepack enable          # activates pnpm from Node's built-in corepack
  ```

## Getting Started

```bash
git clone <repo-url> && cd key-concepts-extractor
pnpm install             # install dependencies (strict mode, no phantom deps)
```

## Scripts

```bash
pnpm test                # run tests (vitest)
pnpm run lint            # lint + format check (biome)
pnpm run typecheck       # type-check without emitting (tsc --noEmit)
```

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript 5.8 |
| Runtime | Node.js 22 (LTS) |
| Package Manager | pnpm |
| Test Runner | Vitest |
| Linter/Formatter | Biome |
| CLI Framework | citty |
| Web Server | Hono |
| WebSocket | @hono/node-ws |
| UI | React + Wouter + Tailwind CSS |
| Validation | Zod |
| Logging | Pino |

## Project Status

In **specs/scaffold** phase — 21 normative specs drive the implementation. `src/` is being built incrementally.

## License

ISC
