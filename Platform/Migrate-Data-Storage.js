/*
Migrate-Data-Storage

One-shot importer: reads every mined dataset file

    <storage>/Project/Data-Mining/.../Data.json

and stores it in the per-market SQLite files used when
DATA_STORAGE_BACKEND=sqlite (see SQLITE_STORAGE.md).

Usage (from the repository root):

    node Platform/Migrate-Data-Storage.js [--market=BTC-USDT] [--dry-run] [--limit=50] [--storage-root=<path>]

The original Data.json files are left untouched: after verifying the
migration manifest you may delete them (or keep them as a backup and
switch back to DATA_STORAGE_BACKEND=json at any time).

Files that fail JSON.parse are reported as corrupt and skipped; those
need to be re-mined, exactly as with the JSON backend.
*/
const fs = require('fs')
const path = require('path')
const datasetMap = require('../Projects/Foundations/TS/Task-Modules/SqliteDatasetMap.js')

let sqlite3
try {
    sqlite3 = require('sqlite3')
} catch (err) {
    console.log('[ERROR] The sqlite3 module is not installed. Run npm install at the repository root first.')
    process.exit(1)
}

const args = process.argv.slice(2)
const options = {
    market: undefined,
    dryRun: false,
    limit: undefined,
    storageRoot: undefined
}
for (let i = 0; i < args.length; i++) {
    if (args[i].indexOf('--market=') === 0) { options.market = args[i].substring('--market='.length) }
    else if (args[i] === '--dry-run') { options.dryRun = true }
    else if (args[i].indexOf('--limit=') === 0) { options.limit = parseInt(args[i].substring('--limit='.length), 10) }
    else if (args[i].indexOf('--storage-root=') === 0) { options.storageRoot = args[i].substring('--storage-root='.length) }
}

const REPO_ROOT = path.join(__dirname, '..')
let storageRoot = options.storageRoot
if (storageRoot === undefined) {
    if (process.env.DATA_PATH) {
        storageRoot = path.join(process.env.DATA_PATH, 'Superalgos_Data', 'My-Data-Storage')
    } else {
        storageRoot = path.join(REPO_ROOT, 'Platform', 'My-Data-Storage')
    }
}
const MINING_ROOT = path.join(storageRoot, 'Project', 'Data-Mining')

async function main() {
    if (fs.existsSync(MINING_ROOT) === false) {
        console.log('[ERROR] Mining storage not found: ' + MINING_ROOT)
        process.exit(1)
    }
    let files = []
    collectDataJsonFiles(MINING_ROOT, files)
    files.sort()
    if (options.market !== undefined) {
        files = files.filter(file => file.indexOf(options.market) >= 0)
    }
    if (options.limit !== undefined) {
        files = files.slice(0, options.limit)
    }
    console.log('[INFO] Found ' + files.length + ' Data.json files' + (options.dryRun === true ? ' (dry run, nothing will be written)' : ''))

    let manifest = {
        migratedAt: new Date().toISOString(),
        storageRoot: storageRoot,
        backend: 'sqlite',
        files: []
    }
    let counters = { ok: 0, skipped: 0, corrupt: 0, failed: 0 }

    for (let i = 0; i < files.length; i++) {
        let absolutePath = files[i]
        let relativePath = path.relative(storageRoot, absolutePath).split(path.sep).join('/')
        let entry = { source: relativePath, db: undefined, table: undefined, rows: 0, ok: false }
        try {
            let parsed = datasetMap.parseDatasetPath(relativePath)
            if (parsed === undefined) {
                entry.error = 'Path shape not supported by the sqlite backend.'
                counters.skipped++
                manifest.files.push(entry)
                continue
            }
            entry.db = parsed.dbRelativePath
            entry.table = parsed.tableName
            let content = fs.readFileSync(absolutePath, 'utf8')
            let rows = JSON.parse(content)
            if (Array.isArray(rows) === false) {
                entry.error = 'Top-level JSON value is not an array.'
                counters.corrupt++
                manifest.files.push(entry)
                continue
            }
            entry.rows = rows.length
            if (options.dryRun === true) {
                entry.ok = true
                counters.ok++
                manifest.files.push(entry)
                continue
            }
            await importRows(storageRoot, parsed, rows)
            let verified = await countRows(storageRoot, parsed)
            if (verified !== rows.length) {
                entry.error = 'Row count mismatch after import (sqlite=' + verified + ', json=' + rows.length + ').'
                counters.failed++
            } else {
                entry.ok = true
                counters.ok++
            }
            manifest.files.push(entry)
        } catch (err) {
            if (err instanceof SyntaxError) {
                entry.error = 'Corrupt JSON, needs re-mining: ' + err.message
                counters.corrupt++
            } else {
                entry.error = String((err && err.message) || err)
                counters.failed++
            }
            manifest.files.push(entry)
        }
        if ((i + 1) % 100 === 0 || i === files.length - 1) {
            console.log('[INFO] Progress ' + (i + 1) + '/' + files.length + ' ok=' + counters.ok + ' skipped=' + counters.skipped + ' corrupt=' + counters.corrupt + ' failed=' + counters.failed)
        }
    }

    if (options.dryRun === false) {
        let manifestPath = path.join(storageRoot, 'sqlite-migration-manifest.json')
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 4))
        console.log('[INFO] Manifest written: ' + manifestPath)
    }
    console.log('[INFO] Done. ok=' + counters.ok + ' skipped=' + counters.skipped + ' corrupt=' + counters.corrupt + ' failed=' + counters.failed)
    if (counters.failed > 0) { process.exit(2) }
}

function collectDataJsonFiles(directory, files) {
    let entries = fs.readdirSync(directory, { withFileTypes: true })
    for (let i = 0; i < entries.length; i++) {
        let fullPath = path.join(directory, entries[i].name)
        if (entries[i].isDirectory() === true) {
            collectDataJsonFiles(fullPath, files)
        } else if (entries[i].isFile() === true && entries[i].name === 'Data.json') {
            files.push(fullPath)
        }
    }
}

function openDatabase(dbLocation) {
    return new Promise((resolve, reject) => {
        let db = new sqlite3.Database(dbLocation, (err) => {
            if (err) { reject(err); return }
            resolve(db)
        })
    })
}

function execAsync(db, sql) {
    return new Promise((resolve, reject) => {
        db.exec(sql, (err) => {
            if (err) { reject(err); return }
            resolve()
        })
    })
}

async function importRows(storageRootPath, parsed, rows) {
    let dbLocation = path.join(storageRootPath, parsed.dbRelativePath.split('/').join(path.sep))
    fs.mkdirSync(path.dirname(dbLocation), { recursive: true })
    let db = await openDatabase(dbLocation)
    try {
        await execAsync(db, 'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000; PRAGMA synchronous=NORMAL;')
        await execAsync(db, 'BEGIN IMMEDIATE')
        let dataWidth = datasetMap.tableWidth(rows)
        await execAsync(db, datasetMap.createTableStatement(parsed.tableName, dataWidth))
        let columns = await allAsync(db, 'PRAGMA table_info("' + parsed.tableName + '")')
        let existingWidth = columns.length - 2
        for (let next = existingWidth; next < dataWidth; next++) {
            await execAsync(db, 'ALTER TABLE "' + parsed.tableName + '" ADD COLUMN c' + next)
        }
        let finalWidth = existingWidth > dataWidth ? existingWidth : dataWidth
        await execAsync(db, 'DELETE FROM "' + parsed.tableName + '"')
        if (rows.length > 0) {
            let placeholders = ['?', '?']
            for (let i = 0; i < finalWidth; i++) { placeholders.push('?') }
            let statement = await prepareAsync(db, 'INSERT INTO "' + parsed.tableName + '" VALUES (' + placeholders.join(', ') + ')')
            try {
                for (let i = 0; i < rows.length; i++) {
                    await runAsync(statement, datasetMap.rowToRecord(rows[i], finalWidth))
                }
            } finally {
                await finalizeAsync(statement)
            }
        }
        await execAsync(db, 'CREATE TABLE IF NOT EXISTS "_meta" (table_name TEXT PRIMARY KEY, source_path TEXT, width INTEGER, rows INTEGER, updated_at INTEGER)')
        let meta = await prepareAsync(db, 'INSERT INTO "_meta" (table_name, source_path, width, rows, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(table_name) DO UPDATE SET source_path=excluded.source_path, width=excluded.width, rows=excluded.rows, updated_at=excluded.updated_at')
        try {
            await runAsync(meta, [parsed.tableName, parsed.sourcePath, finalWidth, rows.length, Date.now()])
        } finally {
            await finalizeAsync(meta)
        }
        await execAsync(db, 'COMMIT')
    } catch (err) {
        try { await execAsync(db, 'ROLLBACK') } catch (rollbackErr) { /* ignored */ }
        throw err
    } finally {
        await closeAsync(db)
    }
}

async function countRows(storageRootPath, parsed) {
    let dbLocation = path.join(storageRootPath, parsed.dbRelativePath.split('/').join(path.sep))
    let db = await openDatabase(dbLocation)
    try {
        let records = await allAsync(db, 'SELECT COUNT(*) AS count FROM "' + parsed.tableName + '"')
        return records[0].count
    } finally {
        await closeAsync(db)
    }
}

function allAsync(db, sql) {
    return new Promise((resolve, reject) => {
        db.all(sql, (err, records) => {
            if (err) { reject(err); return }
            resolve(records)
        })
    })
}

function prepareAsync(db, sql) {
    return new Promise((resolve, reject) => {
        db.prepare(sql, function (err) {
            if (err) { reject(err); return }
            resolve(this)
        })
    })
}

function runAsync(statement, params) {
    return new Promise((resolve, reject) => {
        statement.run(params, (err) => {
            if (err) { reject(err); return }
            resolve()
        })
    })
}

function finalizeAsync(statement) {
    return new Promise((resolve) => {
        statement.finalize(() => { resolve() })
    })
}

function closeAsync(db) {
    return new Promise((resolve) => {
        db.close(() => { resolve() })
    })
}

main().catch((err) => {
    console.log('[ERROR] Migration failed: ' + ((err && err.stack) || err))
    process.exit(1)
})
