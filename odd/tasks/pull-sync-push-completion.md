---
Objetivo: llevar @nuup/offline-kit de pull-only a pull+catalog-sync+push completos, cerrando la brecha con lo que tlacuache_app reimplementó por fuera.
Branch: feature/pull-sync-push-completion (crear desde main antes del primer commit de T2)
Delivery: ask-on-risk | Test runner: vitest (confirmar en package.json)
---

## Specs

- S1: "Pasar estado a fetch (cursores incrementales reales: fetch({table, since, state})), persistiendo el watermark en _nuup_sync_state dentro de la misma transacción."
- S2: "Estrategia `replace` con tabla sombra + swap atómico (subir el patrón de runCatalogSync.ts al kit)."
- S3: "shouldApplyRow asíncrono/por lote y con distinción insert vs update, o alternativamente preserveColumns para proteger columnas de bookkeeping en UPDATE sin afectar el default de INSERT." — decisión tomada con el usuario: implementar `preserveColumns` primero (más simple, sin Map precargado en el consumidor); mover a async solo si aparece un caso real que no cubra.
- S4: "Outbox/push genérico: cola con dependencias, estados in_flight/done/failed, backoff — createPushEngine({adapters})."
- S5: "Batching de escrituras (INSERT multi-fila o prepareAsync/executeAsync) y fetch paginado vía iterator."
- S6: "Observabilidad (hooks de progreso/duración, conteo de skips, separar deletes de upserts en el resultado)."
- S7: "Housekeeping: corregir package.json/README/LICENSE, agregar CHANGELOG, decidir si vale la pena publicar a un registry real dado que hoy es un solo consumidor." — decisión de registry queda pendiente de respuesta del equipo (no se resuelve en este documento); solo se corrige metadata, README y se agrega LICENSE/CHANGELOG.
- S8 (bug ya reportado, fuera del alcance de este kit): huertas/parcelas/cultivos sincronizan por upsert sin `deletedAtColumn` en tlacuache_app — fix de consumo, se trackea aparte cuando tlacuache_api confirme `/changes?since=`. No crea tarea en este documento.

## Tasks

| ID | Specs | Ruta | Estado | Commit/Evidencia |
|----|-------|------|--------|-------------------|
| T1 | — | delegado (explorador read-only) | hecho | mapeo de arquitectura sync (apply.ts/engine.ts/state.ts/types.ts) — ver L3 |
| T2 | S1 | inline (parent) | pendiente | fetch({table, since, state}) + watermark transaccional + fix ROLLBACK (mismo commit, misma zona de transacciones) |
| T3 | S2 | inline (parent) | pendiente | applyReplace con tabla sombra + swap atómico |
| T4 | S3 | inline (parent) | pendiente | preserveColumns en upsert |
| T5 | S4 | delegado (writer, unidad independiente) | pendiente | createPushEngine({adapters}) |
| T6 | S5, S6 | inline (parent) | pendiente | batching + paginación + observabilidad |
| T7 | S7 | delegado (writer, unidad independiente, en paralelo con T2-T4) | hecho | package.json/README/LICENSE/CHANGELOG — ver L4 |

Nota de ruta: T2-T4-T6 tocan el mismo núcleo (apply.ts/engine.ts/types.ts/state.ts) y tienen dependencias secuenciales entre sí (T4 depende del nuevo shape de fila de T2/T3; T6 reutiliza el loop de aplicación que T2/T3 modifican) — se mantienen en el padre siguiendo su logbook, sin razón de Writer trigger (no son unidades independientes). T5 (push engine) y T7 (housekeeping) sí son unidades independientes con superficies disjuntas y pueden delegarse/paralelizarse.

## Log

- L1 (2026-10-24): Petición original del usuario (verbatim, vía mensaje cross-session de tlacuache_app + instrucción directa): plan priorizado para que el kit cubra pull+sync+push de forma real, cerrando la brecha con lo que tlacuache_app ya construyó por fuera. Lista de candidatos entregada por el usuario (orden ajustable): 1) estado en fetch, 2) replace con tabla sombra, 3) push engine, 4) shouldApplyRow async o preserveColumns, 5) batching/paginación, 6) observabilidad, 7) housekeeping.
- L2 (2026-10-24): Usuario pidió "crea un plan con ODD para implementar las mejoras, cuando lo tengas comienza con las tareas usando subagentes" — autoriza implementación y uso de subagentes para las unidades que lo ameriten.
- L3 (2026-10-24): T1 (explorador) completado. Hallazgos clave: RemoteSource.fetch no acepta since/cursor (extensible de forma aditiva); _nuup_sync_state solo guarda table_name/synced_at/row_count (requiere migración para watermark); applyReplace hace DELETE+INSERT sin shadow table; migrations/helpers.ts y runner.ts no usan assertIdentifier a diferencia de sync/apply.ts y state.ts; bug nuevo encontrado (no en las specs originales): adapters/expo-sqlite.ts:102-105 el ROLLBACK no está en su propio try/catch y puede enmascarar el error original.
- L4 (2026-10-24): T7 (housekeeping) completado por writer delegado: package.json y README.md corregidos (descripción real, sin "bidirectional"/"query-store"; referencias #v0.2.0 → #v0.4.0), LICENSE creado (MIT, titular "Nuup" — confirmado por el usuario), CHANGELOG.md creado en formato Keep a Changelog desde git log (0.1.0-0.4.0). Decisión de registry npm queda pendiente, sin resolver en este documento.
- L5 (2026-10-24): Usuario confirmó titular de copyright "Nuup". Usuario pidió incluir el fix de ROLLBACK (adapters/expo-sqlite.ts:102-105) en T2, mismo commit, porque toca la misma zona de transacciones.
