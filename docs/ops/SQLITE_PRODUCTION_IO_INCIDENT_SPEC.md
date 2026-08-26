---
title: "Spec: SQLite production I/O incident and local rebuild"
---

<!-- markdownlint-disable MD025 -->

# SQLite production I/O incident and local rebuild

Status: diagnosis complete, implementation pending
Date: 2026-08-26
Owner: OmniRoute runtime/operations
Scope: omniroute-prod, SQLite runtime selection, Docker packaging and health checks

## 1. Executive summary

The production service recovered after the omniroute-prod container was
recreated. The incident was not caused by a provider outage, a full host disk,
or a corrupt SQLite database.

The most likely root cause is a packaging/runtime mismatch:

1. The production bundle failed to resolve better-sqlite3 and node:sqlite.
2. The application silently fell back to sql.js (WASM).
3. sql.js exports and rewrites the complete database image on each save.
4. The instance generated excessive disk writes and eventually surfaced
   repeated disk I/O error failures across database-backed subsystems.

The source code was designed to prefer a native synchronous driver, but the
compiled bundle contained an empty Webpack module stub for the injected loader.
The native packages existed in the running container and could be loaded by a
direct Node runtime probe, which isolates the failure to the generated bundle.

This document records the evidence and the implementation contract. It does
not change runtime behavior by itself.

## 2. Incident report

### 2.1 Observed timeline

All times below are UTC and come from the production container and host
journal inspected during the incident.

| Time            | Observation                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 16:30:01        | Host cron ran sync; echo 3 > /proc/sys/vm/drop_caches.                                                                          |
| 16:35:01        | The same cache-dropping cron ran again.                                                                                         |
| 16:36:03        | First disk I/O error messages appeared in the OmniRoute logs.                                                                   |
| 16:36 onward    | Errors spread through hot reload, auth limits, batch polling, connection recovery, health checks, quota ping and feature flags. |
| 16:40:01        | The cache-dropping cron ran again while the service was degraded.                                                               |
| 16:41:58        | The production container was manually stopped/recreated.                                                                        |
| 16:41:59        | The container started again; SQLite WAL/SHM files were recreated.                                                               |
| 16:42:30 onward | Routing and background logs returned to normal; no new disk I/O error was observed.                                             |

### 2.2 State after recovery

- omniroute-prod: running and healthy.
- omniroute-redis-prod: running and healthy.
- Dashboard health endpoint: HTTP 200.
- Host filesystem: approximately 70% used, with substantial free space.
- Host inode usage: low; no inode exhaustion.
- SQLite quick_check: ok.
- SQLite integrity_check: ok.
- Kernel logs: no evidence of a physical disk or ext4 failure.

The recovery and integrity checks make permanent database corruption unlikely.
The restart cleared the failing runtime state, but it did not remove the
underlying packaging defect.

## 3. Evidence for the root cause

### 3.1 Native modules existed at runtime

Inside the running container:

- /app/node_modules/better-sqlite3 existed.
- /app/node_modules/sql.js existed.
- require.resolve("better-sqlite3") resolved to the real package.
- require("node:sqlite") succeeded on the installed Node version.
- The explicit Dockerfile copy placed better-sqlite3 under /app/node_modules.

Therefore, "package absent from the image" is not sufficient to explain the
failure.

### 3.2 The production bundle replaced the loader

The source in src/lib/db/adapters/driverFactory.ts creates an injectable loader
with createRequire(import.meta.url) and calls it through
createSyncDriverFactory.

The generated server chunks contained an empty context loader. Its behavior was
equivalent to:

```js
function missingModule(name) {
  const error = new Error("Cannot find module '" + name + "'");
  error.code = "MODULE_NOT_FOUND";
  throw error;
}
```

As a result, both native driver attempts failed inside the packaged server,
even though direct Node probes succeeded. The application then selected the
sql.js fallback.

### 3.3 The fallback explains the write amplification

src/lib/db/adapters/sqljsAdapter.ts uses db.export() and writes the whole
SQLite image to disk. The current save debounce is 100 ms. With a busy
database, this is a full-file rewrite for many logical writes.

The host journal recorded approximately:

```text
1.8T written to disk over 22h40m
7.2G read from disk over 22h40m
1.9G memory peak
1G swap peak
```

This is consistent with sql.js write amplification and is not consistent
with a normal native SQLite runtime for this workload. The host cron that
flushes caches every five minutes is an additional pressure multiplier.

## 4. Correction contract

### 4.1 Required runtime behavior

Production must resolve SQLite in this order:

1. bun:sqlite when running under Bun.
2. Bundled better-sqlite3.
3. node:sqlite on supported Node versions.
4. sql.js only as an explicit last-resort compatibility fallback.

At startup, logs must identify the active driver, for example:

```text
[DB] Driver: better-sqlite3 | file: /app/data/storage.sqlite
```

The application must not report a native driver failure without the original
error, and the packaged artifact must not silently replace literal native
module requests with an empty context stub.

### 4.2 Required build behavior

The production build must:

- keep better-sqlite3 external to the Next.js server bundle;
- preserve the native binary for the target OS, architecture and Node ABI;
- retain the complete sql.js package and WASM asset for fallback tests;
- include a packaged-artifact smoke test that verifies driver resolution;
- verify that generated chunks do not contain the empty missing-module loader for
  the SQLite driver branches.

### 4.3 Required persistence hardening

Even when sql.js is used, persistence must publish the database atomically:

1. export to a temporary file in the same directory;
2. flush the file descriptor;
3. rename the temporary file over the destination;
4. clean up the temporary file after a failure.

This does not make sql.js equivalent to native SQLite, but it removes the window
in which a direct O_TRUNC write exposes a zero-length or partial database to
another reader.

### 4.4 Health contract

Docker liveness and application/database readiness must be separate:

- Docker HEALTHCHECK should use a lightweight /healthz endpoint that does not
  require a deep database operation on every probe.
- The dashboard/deep health endpoint should continue to expose SQLite and
  subsystem status for operators.
- Startup and monitoring must expose the active SQLite driver and the last
  database error.
- A readiness check must fail when the database cannot execute a minimal read.

## 5. Recommended implementation units

The implementation can be split into four small units.

### Unit A: bundle-safe native loader

Update src/lib/db/adapters/driverFactory.ts so each supported native module is
referenced through a direct literal require call inside a small switch. Keep
createSyncDriverFactory injectable for unit tests, but do not pass the production
createRequire function through a generic dynamic context that Next.js/Webpack can
replace.

Reference commit in the repository history: 712910612b (fix(db): bundle and
verify the sql.js fallback). It is not an ancestor of the current branch, so
its implementation must be reviewed and ported deliberately.

### Unit B: fallback persistence safety

Update src/lib/db/adapters/sqljsAdapter.ts to use same-directory temporary file
plus fsync and atomic rename. Add a regression test that proves the published
file is complete and readable during replacement.

Reference commit: b67d9ef353 (fix(db): publish the sql.js database atomically
instead of rewriting it in place). It is not an ancestor of the current branch.

### Unit C: driver and artifact observability

Add or retain explicit startup logging of the selected driver. Extend the
packaged build smoke test to assert:

- the native driver opens a temporary SQLite file;
- the fallback path can be forced only by a test flag;
- the standalone artifact contains required native/WASM assets;
- no generated driver chunk uses the empty missing-module stub.

### Unit D: healthcheck separation

Change the Docker probe in scripts/dev/healthcheck.mjs to /healthz and keep the
deep monitoring endpoint for operator diagnostics. Add tests for both paths and
for the configured base path.

Reference commit: 4c7b902257 (fix(ops): Docker HEALTHCHECK probes /healthz not
deep monitoring). It is not an ancestor of the current branch.

## 6. Local build and VPS delivery procedure

The VPS should consume a locally built artifact because its available memory
is insufficient for the project compilation.

### 6.1 Confirm target compatibility

On the VPS, record:

```bash
uname -m
docker version --format '{{.Server.Arch}}'
node --version
```

Build for the same Docker architecture. For a common amd64 VPS:

```bash
docker buildx build --platform linux/amd64 --target runner-cli \
  -t omniroute:prod-local --load .
```

If the VPS is arm64, replace the platform and confirm that the native
better-sqlite3 binary is built for that target.

### 6.2 Validate locally before transfer

At minimum:

```bash
npm run typecheck:core
npm run test:unit -- tests/unit/db-adapters/driverFactory.test.ts
npm run build
```

For the packaged artifact, also run the repository pack-boot check when the
local environment supports it:

```bash
npm run check:pack-boot
```

The validation result must show a native driver, preferably better-sqlite3, and
must not show an unexpected sql.js fallback.

### 6.3 Transfer the image without rebuilding on the VPS

On the local build machine:

```bash
docker save omniroute:prod-local | gzip > omniroute-prod-local.tar.gz
scp omniroute-prod-local.tar.gz root@VPS:/opt/omniroute/
```

On the VPS:

```bash
gunzip -c /opt/omniroute/omniroute-prod-local.tar.gz | docker load
docker tag omniroute:prod-local omniroute:prod
```

Before recreating the service, back up the production volume and record the
current image ID. Recreate only after the local image has passed the smoke
test. The named volume containing /app/data/storage.sqlite must remain
attached; no database deletion or migration reset is part of this correction.

## 7. Deployment and rollback gates

### Before deployment

- [ ] Local build completed for the VPS architecture.
- [ ] Native SQLite driver loaded in a clean container.
- [ ] SQLite integrity check is ok against a copy of production data.
- [ ] npm run check:pack-boot passed or its limitation was recorded.
- [ ] Current image ID and named-volume backup were recorded.
- [ ] No unrelated worktree artifacts were included in the image context.

### After deployment

- [ ] docker ps reports healthy.
- [ ] Logs contain [DB] Driver: better-sqlite3 or the accepted native
      node:sqlite fallback.
- [ ] Logs do not contain an unexpected synchronous-driver fallback.
- [ ] /healthz responds successfully.
- [ ] /api/monitoring/health reports database readiness.
- [ ] Dashboard and /v1/models respond normally.
- [ ] No new disk I/O error appears during the observation window.
- [ ] Disk write rate returns to the expected baseline.

### Rollback

If the new image fails startup or database readiness, stop the rollout and
repoint the service to the recorded previous image ID. Keep the production
volume intact. Do not remove storage.sqlite, WAL files, or the Docker volume as
a rollback action.

## 8. Host-level follow-up

The root cron entry below is not part of the application image and does not
require a rebuild:

```text
*/5 * * * * /usr/bin/sync; echo 3 > /proc/sys/vm/drop_caches
```

It should be removed or disabled after operator approval. Repeated cache
dropping is not a normal application tuning mechanism and can increase I/O
latency and memory pressure. This is a contributing factor, not a substitute
for fixing the bundle's native-driver resolution.

The unrelated oneuniformes-workerbitrix-8ab1nm image-pull failures observed on
the same host should also be corrected or isolated because their Docker
restart/network churn adds operational noise and I/O pressure.

## 9. Non-goals

- No provider, combo or routing policy change.
- No deletion or reset of the production database.
- No removal of sql.js from the compatibility chain.
- No claim that a successful HTTP health response alone proves SQLite readiness.
- No production restart as part of documenting this spec.

## 10. Acceptance statement

The incident is considered corrected when a locally built artifact, transferred
to the VPS without compiling there, starts against the existing volume, selects
a native SQLite driver, passes database readiness checks, and remains free of
recurring disk I/O error messages during normal dashboard and API traffic.
