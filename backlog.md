# Backlog

- [ ] [MINOR] src/cli/index.ts — Gap : le CLI parse des paths de fichiers (`string[]`) mais le pipeline attend `InputFile[]` (avec content chargé). Scaffolder un adapter `loadInputFiles(paths: string[]): Promise<InputFile[]>` côté infra. (date: 2026-04-15, source: senior-review RED scaffold)
- [ ] [MINOR] src/domain/types.ts — `ConceptCategory`, `GranularityLevel` et `PipelineEvent.type` typés `string`. À resserrer en unions littérales après consultation NIB-S §3 et NIB-M-EVENT-LOGGER en GREEN. (date: 2026-04-15, source: senior-review RED scaffold)
- [ ] [MINOR] src/infra/event-logger.ts — Ajouter `subscribe(listener: (e: PipelineEvent) => void): () => void` pour le pont WebSocket (NIB-M-WEB-SERVER §2.2). (date: 2026-04-15, source: senior-review RED scaffold)
- [ ] [MINOR] tests/run-manager.test.ts:50 — T-RM-04 flaky : run_id à résolution 1s + suffixe nanoid, deux runs créés en <1s peuvent avoir un ordre non déterministe. Ordonner via `created_at` du manifest plutôt que par nom. (date: 2026-04-15, source: senior-review RED scaffold)
- [ ] [MINOR] tests/helpers/control-responses.ts — Schémas R1/R2/R3 inférés de NIB-M-QC/RC §4 (pas de NIB-M-LLM-PAYLOADS lu en détail). À valider/ajuster en GREEN contre les schémas exacts des prompts définis par NIB-M-LLM-PAYLOADS. (date: 2026-04-15, source: implémentation treat-backlog)
- [ ] [MINOR] tests/helpers/mock-provider.ts:4 — Export `MockCallRecord` non importé ailleurs. À garder pour introspection future ou supprimer si non utilisé en GREEN. (date: 2026-04-15, source: senior-review post-treat-backlog)
- [ ] [MINOR] src/web/server.ts:6 — Renommer `WebServerHandle` en `ListeningServer` ou fusionner avec `WebServer` pour cohérence avec convention Node. (date: 2026-04-15, source: senior-review post-treat-backlog)
