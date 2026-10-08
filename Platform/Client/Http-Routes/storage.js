/*
    JSON-optimized /Storage/ route (json-optimizations branch).

    Same endpoint and plain-JSON behaviour as stock, plus a small
    server-side cache that understands the native ?etag= client:

    - Bodies are cached per resource identity (absolute file path, so the
      storage root is part of the key). Two different files can never share
      a cache entry, even if their fingerprints collide.
    - Validators are content fingerprints: sha256 of the stat identity
      (device + inode + birthtime + size + mtime, all as exact integers).
      Same size and mtime on different files still produce different tags.
    - Revalidation: a request carrying ?etag= matching the current
      fingerprint gets an empty 304; a mismatch gets a full 200.
    - A file that changes between stat and read is served with a
      body-derived snapshot tag and is NOT cached, forcing the client to
      revalidate instead of trusting a mislabelled body.
    - Missing files keep the historical 404 body exactly.
    - Bodies larger than the whole cache are served but never cached, and
      never evict useful entries.

    No SQLite anywhere: every dataset read is a plain file read.
*/
exports.newStorageRoute = function newStorageRoute(options) {
    let optionOverrides = options || {}
    const MAX_CACHE_ENTRIES = optionOverrides.maxCacheEntries || 100
    const MAX_CACHE_BYTES = optionOverrides.maxCacheBytes || 256 * 1024 * 1024

    const thisObject = {
        endpoint: 'Storage',
        command: command
    }

    let bodyCache = new Map()
    let cachedBytes = 0

    return thisObject

    function command(httpRequest, httpResponse) {
        handleRequest(httpRequest, httpResponse).catch(function (err) {
            try {
                httpResponse.writeHead(500, { 'Content-Type': 'text/plain' })
                httpResponse.end('Dataset read failed.\n')
            } catch (innerErr) {
                /* The connection is already gone; nothing left to do. */
            }
        })
    }

    async function handleRequest(httpRequest, httpResponse) {
        const fs = getFsModule()
        const path = require('path')
        const storageRoot = path.resolve(global.env.PATH_TO_DATA_STORAGE)

        let rawUrl = httpRequest.url.substring('/Storage/'.length)
        let queryIndex = rawUrl.indexOf('?')
        let queryString = ''
        if (queryIndex !== -1) {
            queryString = rawUrl.substring(queryIndex + 1)
            rawUrl = rawUrl.substring(0, queryIndex)
        }
        let pathToFile = rawUrl
        for (let i = 0; i < 10; i++) {
            pathToFile = pathToFile.replace('_HASHTAG_', '#')
        }

        let absolutePath = path.resolve(storageRoot, pathToFile)
        let relative = path.relative(storageRoot, absolutePath)
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(pathToFile)) {
            sendMissing(httpResponse)
            return
        }

        let clientEtag
        try {
            const params = new URLSearchParams(queryString)
            clientEtag = params.get('etag') || undefined
        } catch (err) {
            clientEtag = undefined
        }

        let statBefore
        try {
            statBefore = await fs.promises.stat(absolutePath, { bigint: true })
            if (statBefore.isDirectory()) {
                sendMissing(httpResponse)
                return
            }
        } catch (err) {
            sendMissing(httpResponse)
            return
        }

        let currentEtag = etagFor(absolutePath, identityOf(statBefore))
        if (clientEtag !== undefined && clientEtag === currentEtag) {
            sendNotModified(httpResponse, currentEtag)
            return
        }

        let cached = getCached(absolutePath, currentEtag)
        if (cached !== undefined) {
            sendBody(httpResponse, currentEtag, cached)
            return
        }

        let body
        try {
            body = (await fs.promises.readFile(absolutePath)).toString()
        } catch (err) {
            sendMissing(httpResponse)
            return
        }

        let statAfter
        try {
            statAfter = await fs.promises.stat(absolutePath, { bigint: true })
        } catch (err) {
            statAfter = undefined
        }

        if (statAfter !== undefined && sameIdentity(statBefore, statAfter)) {
            setCached(absolutePath, currentEtag, body)
            sendBody(httpResponse, currentEtag, body)
            return
        }

        /*
            The file changed (or vanished) between stat and read. Serve what
            was read, but label it with a snapshot tag and do not cache it,
            so the next request revalidates instead of trusting this body.
        */
        sendBody(httpResponse, etagFor(absolutePath, ['snapshot', body]), body)
    }

    function identityOf(stat) {
        return [
            stat.dev.toString(),
            stat.ino.toString(),
            stat.size.toString(),
            stat.mtimeNs.toString(),
            stat.birthtimeNs.toString()
        ]
    }

    function sameIdentity(first, second) {
        return first.dev === second.dev &&
            first.ino === second.ino &&
            first.size === second.size &&
            first.mtimeNs === second.mtimeNs &&
            first.birthtimeNs === second.birthtimeNs
    }

    function etagFor(absolutePath, revision) {
        const crypto = require('crypto')
        return '"' + crypto.createHash('sha256').update(JSON.stringify([absolutePath, revision])).digest('hex') + '"'
    }

    function getCached(absolutePath, etag) {
        let record = bodyCache.get(absolutePath)
        if (record === undefined) {
            return undefined
        }
        if (record.etag !== etag) {
            cachedBytes -= record.size
            bodyCache.delete(absolutePath)
            return undefined
        }
        bodyCache.delete(absolutePath)
        bodyCache.set(absolutePath, record)
        return record.body
    }

    function setCached(absolutePath, etag, body) {
        const Buffer = require('buffer').Buffer
        let size = Buffer.byteLength(body)
        let previous = bodyCache.get(absolutePath)
        if (previous !== undefined) {
            cachedBytes -= previous.size
            bodyCache.delete(absolutePath)
        }
        if (size > MAX_CACHE_BYTES) {
            return
        }
        while ((bodyCache.size >= MAX_CACHE_ENTRIES || cachedBytes + size > MAX_CACHE_BYTES) && bodyCache.size > 0) {
            let oldest = bodyCache.keys().next()
            if (oldest.done) {
                break
            }
            let victim = bodyCache.get(oldest.value)
            cachedBytes -= victim.size
            bodyCache.delete(oldest.value)
        }
        bodyCache.set(absolutePath, { etag: etag, body: body, size: size })
        cachedBytes += size
    }

    function baseHeaders(etag) {
        return {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'ETag',
            'Content-Type': 'text/html',
            'ETag': etag
        }
    }

    function sendBody(httpResponse, etag, body) {
        httpResponse.writeHead(200, baseHeaders(etag))
        httpResponse.end(body + '\n')
    }

    function sendNotModified(httpResponse, etag) {
        httpResponse.writeHead(304, baseHeaders(etag))
        httpResponse.end()
    }

    function sendMissing(httpResponse) {
        httpResponse.writeHead(404, {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/html'
        })
        httpResponse.end('The specified key does not exist.\n')
    }

    function getFsModule() {
        if (typeof SA !== 'undefined' && SA.nodeModules !== undefined && SA.nodeModules.fs !== undefined) {
            return SA.nodeModules.fs
        }
        return require('fs')
    }
}
