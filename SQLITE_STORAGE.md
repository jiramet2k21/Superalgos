# SQLite Dataset Storage

## The problem

Superalgos stores mined data (candles, indicators, studies) as `Data.json`
files under `Platform/My-Data-Storage/Project/Data-Mining/...`. Every bot
cycle rewrites each file in full with this sequence (`FileStorage.js`):

1. write `Data.json.tmp`
2. delete `Data.json`
3. rename `Data.json.tmp` → `Data.json`

If Node.js crashes, errors out, or the terminal is closed between steps 1
and 3, the dataset is left missing, empty or truncated. The next read then
fails JSON parsing, the task retries 10 times and gives up, and the only
documented remedy is to delete the market folder and re-mine everything
from scratch (see the `troubleshooting-013` tutorial).

## The fix

Set `DATA_STORAGE_BACKEND=sqlite` to store the same mined datasets in
per-market SQLite files instead of JSON files:

    Project/Data-Mining/Data-Mine/<mine>/<bot>/<exchange>/<market>.sqlite

with one table per dataset. Every write runs inside a single SQLite
transaction (`BEGIN IMMEDIATE ... COMMIT`) in WAL mode: a crash either
commits everything or nothing, so **a dataset can never be half-written**.
A torn write simply leaves the previous committed version in place and
mining resumes where it stopped.

Only one backend is active at a time. Trading engine outputs
(`Project/Algorithmic-Trading/...`) always stay JSON files.

## Setup

Requirements: the `sqlite3` package (already a dependency at the
repository root) with a working native binding. Both the Task Server
(`TaskServerRoot.js`) and the Platform (`PlatformRoot.js`) register it
defensively: if it cannot be loaded, the backend reports unavailable and
Superalgos silently uses JSON files.

1. Migrate the existing JSON datasets (one time per PC):

       cd <superalgos-repo>
       node Platform/Migrate-Data-Storage.js [--market=BTC-USDT] [--dry-run] [--limit=50]

   Every imported file is verified by row count and recorded in
   `Platform/My-Data-Storage/sqlite-migration-manifest.json`. Files with
   corrupt JSON are reported and skipped (re-mine those as before).

2. Enable the backend. Either export the variable before launching:

       DATA_STORAGE_BACKEND=sqlite node platform

   or set it in a launch profile (`profile.dataStorageBackend = 'sqlite'`).

3. Run data mining / backtests as usual. After you are satisfied the
   migration is complete you may delete the old
   `Project/Data-Mining/**/Data.json` files to reclaim disk space —
   or keep them as a backup.

Rollback at any time: stop Superalgos, unset the variable (or set it to
`json`) and start again. The JSON files are untouched by the migration
unless you deleted them.

## Compatibility notes

* All readers and writers go through the same `FileStorage`
  (`getTextFile` / `createTextFile` / `deleteTextFile`) signatures, so bot
  code is unchanged. In `json` mode nothing changes at all; in `sqlite`
  mode only local `Project/Data-Mining/.../Data.json` paths are rerouted
  (remote hosts over HTTP keep working as before).
* Values keep their exact Javascript types (SQLite BLOB affinity), so
  `JSON.stringify` of a sqlite-backed read is byte-identical to the
  original file content: column order, numbers, strings and nulls.
* Charting (`/Storage/` route) serves sqlite-backed datasets transparently;
  a missing dataset still answers `404 / The specified key does not exist.`
  exactly like a missing file.
* The JSON path is also hardened whether or not you switch backends:
  `Data.json` writes now keep a `.Previous.json` copy by default and reads
  fall back to it when the current file is empty or unparseable.
* Multi-process safety: mining tasks are separate OS processes sharing one
  storage folder. Databases use WAL mode with a 30 s busy timeout, an
  immediate write transaction per cycle, and an in-process write queue per
  database file, so concurrent readers and writers do not corrupt data.
* `sqlite3` native bindings are platform-specific. The `.sqlite` files (and
  the migration manifest) are machine-local data: each PC runs the
  migration locally. They must not be committed to git.

## Trading-Terminal (separate folder)

The terminal at `C:/Superalgos/Trading-Terminal` reads `Data.json` files
raw from disk and is not part of this repository, so it cannot use this
backend directly. While `DATA_STORAGE_BACKEND=sqlite` is active there are
two options:

1. Keep a JSON copy: run mining once in `json` mode (or keep the
   pre-migration JSON files) for the terminal to read.
2. Add a small reader shim in the terminal that opens
   `<market>.sqlite` and returns `JSON.stringify(rows)` — the table layout
   is `begin INTEGER PRIMARY KEY, end INTEGER, c0, c1, ...` ordered by
   `begin ASC`, table names derivable from `SqliteDatasetMap.js`.
