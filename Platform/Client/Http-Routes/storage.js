exports.newStorageRoute = function newStorageRoute(options = {}) {
    const fs = SA.nodeModules.fs
    const path = require('path')
    const crypto = require('crypto')
    const thisObject = {
        endpoint: 'Storage',
        command: command,
        finalize: finalize
    }

    /*
    Bodies are keyed by RESOURCE, never by ETag. Unrelated databases,
    tables and JSON files can have identical revision numbers or mtimes.
    Map insertion order doubles as LRU order (refresh on hit).
    */
    const MAX_CACHE_ENTRIES = 100
    const MAX_CACHE_BYTES = 256 * 1024 * 1024
    const storageCache = new Map()
    let storageCacheBytes = 0
    /* data_version is comparable only on the SAME connection. Keep a
    bounded set of read-only connections and serialize work per database
    so requests cannot interleave transactions on a shared connection. */
    const MAX_SQLITE_READERS = options.maxSqliteReaders || 32
    const SQLITE_IDLE_MS = options.sqliteIdleMs || 60000
    const sqliteReaders = new Map()
    const sqliteQueue = []
    let finalized = false

    return thisObject

    function command(httpRequest, httpResponse) {
        let pathToFile = httpRequest.url.substring(9)
        /* Unsaving # */
        for (let i = 0; i < 10; i++) {
            pathToFile = pathToFile.replace('_HASHTAG_', '#')
        }
        /*
        Storage clients append ?etag=<fingerprint> for revalidation. A query
        string keeps the request CORS-simple (a custom If-None-Match header
        would trigger a preflight the Platform server cannot answer).
        Legitimate storage paths never contain '?' (the terminal rejects
        them), so stripping it is safe.
        */
        let clientEtag
        let queryIndex = pathToFile.indexOf('?')
        if (queryIndex >= 0) {
            let params = new URLSearchParams(pathToFile.substring(queryIndex + 1))
            clientEtag = params.get('etag') || undefined
            pathToFile = pathToFile.substring(0, queryIndex)
        }
        const storageRoot = path.resolve(global.env.PATH_TO_DATA_STORAGE)
        const response = useSqliteBackend(pathToFile)
            ? readDatasetFromSqlite(storageRoot, pathToFile, clientEtag)
            : readFileFromDisk(storageRoot, pathToFile, clientEtag)
        response.then(result => {
            if (result.status === 404) {
                respondMissing(httpResponse)
            } else if (result.status === 304) {
                serveNotModified(httpResponse, result.etag)
            } else {
                serveBody(httpResponse, result.body, result.etag)
            }
        }).catch(err => {
            if (err.code === 'ENOENT' || err.code === 'ENOTDIR'
                || (err.code === 'SQLITE_ERROR' && /no such table:/.test(err.message))) {
                respondMissing(httpResponse)
                return
            }
            /* A failed read is not evidence that a dataset is absent. */
            responseHeaders(httpResponse)
            httpResponse.writeHead(503, { 'Content-Type': 'text/plain' })
            httpResponse.end('Dataset read failed.\n')
        })
    }

    function useSqliteBackend(pathToFile) {
        if (global.env.DATA_STORAGE_BACKEND !== 'sqlite') { return false }
        let datasetMap
        try {
            datasetMap = require('../../../Projects/Foundations/TS/Task-Modules/SqliteDatasetMap.js')
        } catch (err) {
            return false
        }
        return datasetMap.isSqlitePath(pathToFile)
    }

    function fileIdentity(stats) {
        return [stats.dev, stats.ino, stats.birthtimeNs].join(':')
    }

    function fileRevision(stats) {
        return [fileIdentity(stats), stats.size, stats.mtimeNs, stats.ctimeNs].join(':')
    }

    function etagFor(resource, revision) {
        return '"' + crypto.createHash('sha256').update(JSON.stringify([resource, revision])).digest('hex') + '"'
    }

    function getCached(resource, etag) {
        let entry = storageCache.get(resource)
        if (entry === undefined) { return undefined }
        if (entry.etag !== etag) {
            deleteCached(resource)
            return undefined
        }
        /* LRU refresh. */
        storageCache.delete(resource)
        storageCache.set(resource, entry)
        return entry
    }

    function deleteCached(resource) {
        let entry = storageCache.get(resource)
        if (entry === undefined) { return }
        storageCacheBytes -= entry.bytes
        storageCache.delete(resource)
    }

    function setCached(resource, etag, body) {
        let bytes = Buffer.byteLength(body)
        deleteCached(resource)
        if (bytes > MAX_CACHE_BYTES) { return }
        while ((storageCache.size >= MAX_CACHE_ENTRIES || storageCacheBytes + bytes > MAX_CACHE_BYTES) && storageCache.size > 0) {
            let oldest = storageCache.keys().next().value
            deleteCached(oldest)
        }
        storageCache.set(resource, { etag: etag, body: body, bytes: bytes })
        storageCacheBytes += bytes
    }

    function responseHeaders(httpResponse) {
        httpResponse.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate') // HTTP 1.1.
        httpResponse.setHeader('Pragma', 'no-cache') // HTTP 1.0.
        httpResponse.setHeader('Expires', '0') // Proxies.
        httpResponse.setHeader('Access-Control-Allow-Origin', '*') // Allows to access data from other domains.
        httpResponse.setHeader('Access-Control-Expose-Headers', 'ETag') // Lets browser JS read the ETag cross-origin.
    }

    function serveBody(httpResponse, body, etag) {
        responseHeaders(httpResponse)
        httpResponse.writeHead(200, { 'Content-Type': 'text/html', 'ETag': etag })
        httpResponse.write(body)
        httpResponse.end('\n')
    }

    function serveNotModified(httpResponse, etag) {
        responseHeaders(httpResponse)
        httpResponse.writeHead(304, { 'ETag': etag })
        httpResponse.end()
    }

    function respondMissing(httpResponse) {
        SA.projects.foundations.utilities.httpResponses.respondWithContent(undefined, httpResponse)
    }

    function storageLocation(storageRoot, relative) {
        const location = path.resolve(storageRoot, relative)
        const withinRoot = path.relative(storageRoot, location)
        if (withinRoot === '..' || withinRoot.startsWith('..' + path.sep) || path.isAbsolute(withinRoot)) {
            throw Object.assign(new Error('Storage path is outside the data root.'), { code: 'ENOENT' })
        }
        return location
    }

    async function readFileFromDisk(storageRoot, relative, clientEtag) {
        const fileLocation = storageLocation(storageRoot, relative)
        const resource = JSON.stringify(['json', fileLocation])
        const revision = fileRevision(await fs.promises.stat(fileLocation, { bigint: true }))
        const etag = etagFor(resource, revision)
        if (clientEtag === etag) { return { status: 304, etag: etag } }
        const cached = getCached(resource, etag)
        if (cached !== undefined) { return { body: cached.body, etag: etag } }
        const body = (await fs.promises.readFile(fileLocation)).toString()
        /* Do not associate a body with a revision observed before a
        concurrent write/rename. An uncached, body-based tag forces a fresh
        read on the next revalidation. */
        let unchanged = false
        try {
            unchanged = revision === fileRevision(await fs.promises.stat(fileLocation, { bigint: true }))
        } catch (err) {
            if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') { throw err }
        }
        if (unchanged) {
            setCached(resource, etag, body)
            return { body: body, etag: etag }
        }
        return { body: body, etag: etagFor(resource, ['snapshot', body]) }
    }

    async function readDatasetFromSqlite(storageRoot, pathToFile, clientEtag) {
        let datasetMap
        let sqlite3
        try {
            datasetMap = require('../../../Projects/Foundations/TS/Task-Modules/SqliteDatasetMap.js')
            sqlite3 = SA.nodeModules.sqlite3
            if (sqlite3 === undefined) { sqlite3 = require('sqlite3') }
        } catch (err) {
            return { status: 404 }
        }
        let parsed = datasetMap.parseDatasetPath(pathToFile)
        if (parsed === undefined) { return { status: 404 } }
        const dbLocation = storageLocation(storageRoot, parsed.dbRelativePath)
        const resource = JSON.stringify(['sqlite', dbLocation, parsed.tableName])
        return withSqliteReader(dbLocation, async reader => {
            /* Detect deleted/replaced database files as well as ordinary
            commits; an open handle alone can keep an old file alive. */
            const identity = fileIdentity(await fs.promises.stat(dbLocation, { bigint: true }))
            if (reader.db !== undefined && identity !== reader.identity) {
                await closeDatabase(reader.db)
                reader.db = undefined
            }
            if (reader.db === undefined) {
                reader.db = await openDatabase(sqlite3, dbLocation)
                reader.identity = identity
                reader.generation = crypto.randomBytes(16).toString('hex')
                await exec(reader.db, 'PRAGMA busy_timeout=30000')
            }
            const db = reader.db
            await exec(db, 'BEGIN')
            let result
            let version
            try {
                /* This schema read pins the snapshot and checks existence
                BEFORE consulting cached bodies or returning 304. */
                const table = await get(db, 'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?', [parsed.tableName])
                if (table === undefined) {
                    deleteCached(resource)
                    await exec(db, 'COMMIT')
                    return { status: 404 }
                }
                version = (await get(db, 'PRAGMA data_version')).data_version
                const etag = etagFor(resource, [reader.generation, version])
                const cached = getCached(resource, etag)
                if (clientEtag === etag) {
                    result = { status: 304, etag: etag }
                } else if (cached !== undefined) {
                    result = { body: cached.body, etag: etag }
                } else {
                    const records = await all(db, 'SELECT * FROM "' + parsed.tableName + '" ORDER BY seq ASC')
                    result = { body: recordsToBody(records), etag: etag }
                }
                await exec(db, 'COMMIT')
            } catch (err) {
                await exec(db, 'ROLLBACK').catch(() => {})
                throw err
            }
            const currentVersion = (await get(db, 'PRAGMA data_version')).data_version
            if (version === currentVersion) {
                if (result.body !== undefined) { setCached(resource, result.etag, result.body) }
                return result
            }
            /* A writer committed during the snapshot read. Do not label
            an old snapshot with the newer revision or cache it under that
            revision. Leave it uncached and force a fresh validation. */
            deleteCached(resource)
            if (result.body !== undefined) {
                return { body: result.body, etag: etagFor(resource, ['snapshot', result.body]) }
            }
            /* For a raced 304, read a complete snapshot rather than asking
            the client to reuse a body that we now know has changed. */
            const records = await all(db, 'SELECT * FROM "' + parsed.tableName + '" ORDER BY seq ASC')
            const body = recordsToBody(records)
            return { body: body, etag: etagFor(resource, ['snapshot', body]) }
        })
    }

    function recordsToBody(records) {
        /* SELECT * includes the same columns in every record. c0..cn
        contain ALL original cells; begin/end are only indexed copies. */
        const width = records.length === 0 ? 0 : Object.keys(records[0]).length - 3
        let parts = ['[']
        for (let i = 0; i < records.length; i++) {
            if (i > 0) { parts.push(',') }
            parts.push('[')
            for (let c = 0; c < width; c++) {
                if (c > 0) { parts.push(',') }
                const fragment = records[i]['c' + c]
                parts.push(fragment === undefined || fragment === null ? 'null' : typeof fragment === 'string' ? fragment : JSON.stringify(fragment))
            }
            parts.push(']')
        }
        parts.push(']')
        return parts.join('')
    }

    function withSqliteReader(location, read) {
        return new Promise((resolve, reject) => {
            if (finalized) { reject(new Error('Storage route is closed.')); return }
            sqliteQueue.push({ location: location, read: read, resolve: resolve, reject: reject })
            pumpSqliteQueue()
        })
    }

    function pumpSqliteQueue() {
        if (finalized) { return }
        for (let i = 0; i < sqliteQueue.length; i++) {
            const job = sqliteQueue[i]
            let reader = sqliteReaders.get(job.location)
            if (reader !== undefined && (reader.busy || reader.retiring)) { continue }
            if (reader === undefined) {
                if (sqliteReaders.size >= MAX_SQLITE_READERS) {
                    const idle = Array.from(sqliteReaders.values()).find(item => !item.busy && !item.retiring)
                    if (idle !== undefined) { retireReader(idle) }
                    continue
                }
                reader = { location: job.location, busy: false, retiring: false }
                sqliteReaders.set(job.location, reader)
            }
            sqliteQueue.splice(i--, 1)
            clearTimeout(reader.idleTimer)
            reader.busy = true
            reader.completion = runReaderJob(reader, job)
        }
    }

    async function runReaderJob(reader, job) {
        let failed = false
        try {
            job.resolve(await job.read(reader))
        } catch (err) {
            failed = true
            job.reject(err)
        } finally {
            reader.busy = false
            sqliteReaders.delete(reader.location)
            sqliteReaders.set(reader.location, reader)
            if (failed || finalized) {
                retireReader(reader)
            } else {
                reader.idleTimer = setTimeout(() => retireReader(reader), SQLITE_IDLE_MS)
                reader.idleTimer.unref()
            }
            pumpSqliteQueue()
        }
    }

    function retireReader(reader) {
        if (reader.retirement !== undefined) { return reader.retirement }
        reader.retiring = true
        clearTimeout(reader.idleTimer)
        reader.retirement = (async () => {
            if (reader.db !== undefined) { await closeDatabase(reader.db).catch(() => {}) }
            sqliteReaders.delete(reader.location)
            pumpSqliteQueue()
        })()
        return reader.retirement
    }

    async function finalize() {
        finalized = true
        for (const job of sqliteQueue.splice(0)) { job.reject(new Error('Storage route is closed.')) }
        await Promise.all(Array.from(sqliteReaders.values()).map(async reader => {
            await reader.completion
            await retireReader(reader)
        }))
        storageCache.clear()
        storageCacheBytes = 0
    }

    function openDatabase(sqlite3, location) {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(location, sqlite3.OPEN_READONLY, err => {
                if (err) { db.close(() => {}); reject(err); return }
                resolve(db)
            })
        })
    }

    function closeDatabase(db) {
        return new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()))
    }

    function exec(db, sql) {
        return new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve()))
    }

    function get(db, sql, params = []) {
        return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)))
    }

    function all(db, sql) {
        return new Promise((resolve, reject) => db.all(sql, (err, records) => err ? reject(err) : resolve(records)))
    }
}
