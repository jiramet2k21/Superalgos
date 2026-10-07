exports.newStorageRoute = function newStorageRoute() {
    const thisObject = {
        endpoint: 'Storage',
        command: command
    }

    /*
    Server-side dataset cache. The terminal polls /Storage/ continuously
    (chart + history + regime + 30s slow polls) and every poll re-read and
    re-serialized full multi-MB datasets on libuv worker threads, pinning
    CPU even with zero mining activity. Cached entries avoid all of that
    work when the underlying files did not change.
    Map insertion order doubles as LRU order (refresh on hit).
    */
    const MAX_CACHE_ENTRIES = 100
    const MAX_CACHE_BYTES = 256 * 1024 * 1024
    const storageCache = new Map()
    let storageCacheBytes = 0

    return thisObject

    function command(httpRequest, httpResponse) {
        let pathToFile = httpRequest.url.substring(9)
        /* Unsaving # */
        for (let i = 0; i < 10; i++) {
            pathToFile = pathToFile.replace('_HASHTAG_', '#')
        }
        /*
        The terminal appends ?etag=<fingerprint> for revalidation. A query
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
        if (useSqliteBackend(pathToFile) === true) {
            serveDatasetFromSqlite(pathToFile, httpResponse, clientEtag)
            return
        }
        serveFileFromDisk(pathToFile, httpResponse, clientEtag)
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

    /*
    Fingerprints are stat-only (no file content read): mtimeMs + size.
    Mining rewrites whole files per cycle, so any content change moves at
    least one of them. A stat/read race can only serve a stale body once;
    the etag then mismatches on the next revalidation and heals itself.
    */
    function fingerprintOfFile(fileLocation) {
        const fs = SA.nodeModules.fs
        let stats = fs.statSync(fileLocation)
        return stats.mtimeMs + '-' + stats.size
    }

    function etagFor(fingerprint) {
        return '"' + fingerprint + '"'
    }

    function getCached(fingerprint) {
        let entry = storageCache.get(fingerprint)
        if (entry === undefined) { return undefined }
        /* LRU refresh. */
        storageCache.delete(fingerprint)
        storageCache.set(fingerprint, entry)
        return entry
    }

    function setCached(fingerprint, body) {
        let bytes = Buffer.byteLength(body)
        while ((storageCache.size >= MAX_CACHE_ENTRIES || storageCacheBytes + bytes > MAX_CACHE_BYTES) && storageCache.size > 0) {
            let oldest = storageCache.keys().next().value
            storageCacheBytes -= storageCache.get(oldest).bytes
            storageCache.delete(oldest)
        }
        storageCache.set(fingerprint, { body: body, bytes: bytes })
        storageCacheBytes += bytes
    }

    function serveBody(httpResponse, body, etag) {
        httpResponse.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate') // HTTP 1.1.
        httpResponse.setHeader('Pragma', 'no-cache') // HTTP 1.0.
        httpResponse.setHeader('Expires', '0') // Proxies.
        httpResponse.setHeader('Access-Control-Allow-Origin', '*') // Allows to access data from other domains.
        httpResponse.setHeader('Access-Control-Expose-Headers', 'ETag') // Lets browser JS read the ETag cross-origin.
        httpResponse.writeHead(200, { 'Content-Type': 'text/html', 'ETag': etag })
        httpResponse.write(body)
        httpResponse.end('\n')
    }

    function serveNotModified(httpResponse, etag) {
        httpResponse.setHeader('Access-Control-Allow-Origin', '*')
        httpResponse.setHeader('Access-Control-Expose-Headers', 'ETag')
        httpResponse.writeHead(304, { 'ETag': etag })
        httpResponse.end()
    }

    function serveFileFromDisk(pathToFile, httpResponse, clientEtag) {
        let fileLocation = global.env.PATH_TO_DATA_STORAGE + '/' + pathToFile
        let fingerprint
        try {
            fingerprint = fingerprintOfFile(fileLocation)
        } catch (err) {
            /* Missing file: historical 404 behaviour preserved. */
            SA.projects.foundations.utilities.httpResponses.respondWithFile(fileLocation, httpResponse)
            return
        }
        let etag = etagFor('json:' + fingerprint)
        if (clientEtag === etag) {
            serveNotModified(httpResponse, etag)
            return
        }
        let cached = getCached(etag)
        if (cached !== undefined) {
            serveBody(httpResponse, cached.body, etag)
            return
        }
        const fs = SA.nodeModules.fs
        fs.readFile(fileLocation, onFileRead)

        function onFileRead(err, file) {
            if (err) {
                SA.projects.foundations.utilities.httpResponses.respondWithContent(undefined, httpResponse)
                return
            }
            let body = file.toString()
            setCached(etag, body)
            serveBody(httpResponse, body, etag)
        }
    }

    function serveDatasetFromSqlite(pathToFile, httpResponse, clientEtag) {
        let httpResponses = SA.projects.foundations.utilities.httpResponses
        let datasetMap
        let sqlite3
        try {
            datasetMap = require('../../../Projects/Foundations/TS/Task-Modules/SqliteDatasetMap.js')
            sqlite3 = SA.nodeModules.sqlite3
            if (sqlite3 === undefined) { sqlite3 = require('sqlite3') }
        } catch (err) {
            /* Driver unavailable: behave as if the file did not exist. */
            httpResponses.respondWithContent(undefined, httpResponse)
            return
        }
        let parsed = datasetMap.parseDatasetPath(pathToFile)
        if (parsed === undefined) {
            httpResponses.respondWithContent(undefined, httpResponse)
            return
        }
        let dbLocation = global.env.PATH_TO_DATA_STORAGE + '/' + parsed.dbRelativePath
        let db = new sqlite3.Database(dbLocation, sqlite3.OPEN_READONLY, onOpen)

        function onOpen(err) {
            if (err) {
                httpResponses.respondWithContent(undefined, httpResponse)
                return
            }
            /* Brief waits instead of instant SQLITE_BUSY when a mining
            writer holds the database: reads slow down slightly instead of
            failing into client retry storms. */
            db.exec('PRAGMA busy_timeout=30000', onPragmas)
        }

        function onPragmas(err) {
            if (err) {
                db.close()
                httpResponses.respondWithContent(undefined, httpResponse)
                return
            }
            /*
            Fingerprint without reading the dataset: PRAGMA data_version
            increments on every committed write transaction (even into the
            WAL, even from another process). File mtimes are deliberately
            NOT used: WAL commits may leave the main db file untouched
            until checkpoint, while the -wal/-shm sidecars appear and
            vanish with connection lifecycles, so stat-based fingerprints
            jitter with zero data change. A data_version is per database
            file, so a write to a sibling table only costs one extra cache
            rebuild, never a wrong 304.
            */
            db.get('PRAGMA data_version', onVersion)
        }

        function onVersion(err, versionRow) {
            if (err || versionRow === undefined) {
                db.close()
                httpResponses.respondWithContent(undefined, httpResponse)
                return
            }
            let etag = etagFor('sqlite:' + versionRow.data_version)
            if (clientEtag === etag) {
                db.close()
                serveNotModified(httpResponse, etag)
                return
            }
            let cached = getCached(etag)
            if (cached !== undefined) {
                db.close()
                serveBody(httpResponse, cached.body, etag)
                return
            }
            db.all('SELECT * FROM "' + parsed.tableName + '" ORDER BY seq ASC', function (err, records) { onRows(etag, err, records) })
        }

        function onRows(etag, err, records) {
            db.close()
            if (err) {
                httpResponses.respondWithContent(undefined, httpResponse)
                return
            }
            let width = 0
            for (let i = 0; i < records.length; i++) {
                let keys = Object.keys(records[i])
                /* Keys are seq, begin, end, c0..cn. */
                if (keys.length - 3 > width) { width = keys.length - 3 }
            }
            /*
            Cells are stored as pre-encoded JSON fragments (see
            SqliteDatasetMap), so the body is built by concatenation
            instead of per-cell JSON.parse + JSON.stringify: byte-identical
            output at a fraction of the CPU cost.
            */
            let parts = ['[']
            for (let i = 0; i < records.length; i++) {
                if (i > 0) { parts.push(',') }
                let record = records[i]
                parts.push('[')
                for (let c = 0; c < width; c++) {
                    if (c > 0) { parts.push(',') }
                    parts.push(fragmentToJson(record['c' + c]))
                }
                parts.push(']')
            }
            parts.push(']')
            let body = parts.join('')
            setCached(etag, body)
            serveBody(httpResponse, body, etag)
        }

        function fragmentToJson(fragment) {
            if (fragment === undefined || fragment === null) { return 'null' }
            if (typeof fragment === 'string') { return fragment }
            return JSON.stringify(fragment)
        }
    }
}
