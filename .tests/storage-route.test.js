/* Real SQLite regressions for /Storage/. Run: npm run unitTest -- --runInBand storage-route */
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const datasetMap = require('../Projects/Foundations/TS/Task-Modules/SqliteDatasetMap')
const { newStorageRoute } = require('../Platform/Client/Http-Routes/storage')
const { newFoundationsUtilitiesHttpResponses } = require('../Projects/Foundations/SA/Utilities/HttpResponses')

const tempParent = process.platform === 'win32'
    ? path.join(os.tmpdir(), 'opencode') : os.tmpdir()
let root, route, routes, writers, driver, reads, opens, openReaders, peakReaders
let afterSchema, afterSelect, failRead
const originalSA = global.SA
const originalEnv = global.env

function dataset(product = 'Candles', timeframe = '01-hs', market = 'BTC-USDT', day) {
    const suffix = day ? 'Multi-Time-Frame-Daily/' + timeframe + '/' + day : 'Multi-Time-Frame-Market/' + timeframe
    return 'Project/Data-Mining/Data-Mine/Candles/Candles-Volumes/binance/' + market + '/Output/' + product + '/' + suffix + '/Data.json'
}

function request(relative, etag, target = route) {
    return new Promise((resolve, reject) => {
        const response = { status: undefined, headers: {}, body: '' }
        const timer = setTimeout(() => reject(new Error('Storage request did not settle: ' + relative)), 5000)
        const res = {
            setHeader(name, value) { response.headers[name] = value },
            writeHead(status, headers) { response.status = status; Object.assign(response.headers, headers) },
            write(body) { response.body += body },
            end(body) {
                clearTimeout(timer)
                if (body !== undefined) { response.body += body }
                resolve(response)
            }
        }
        target.command({ url: '/Storage/' + relative + (etag ? '?etag=' + encodeURIComponent(etag) : '') }, res)
    })
}

function exec(db, sql) {
    return new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve()))
}

function close(db) {
    return new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()))
}

async function writer(relative, storageRoot = root) {
    const parsed = datasetMap.parseDatasetPath(relative)
    const location = path.resolve(storageRoot, parsed.dbRelativePath)
    let db = writers.get(location)
    if (!db) {
        fs.mkdirSync(path.dirname(location), { recursive: true })
        db = await new Promise((resolve, reject) => {
            const connection = new sqlite3.Database(location, err => err ? reject(err) : resolve(connection))
        })
        writers.set(location, db)
        await exec(db, 'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=3000')
    }
    return { db, parsed, location }
}

async function put(relative, rows, storageRoot = root) {
    const { db, parsed } = await writer(relative, storageRoot)
    const width = datasetMap.tableWidth(rows)
    const layout = { ...datasetMap.detectBeginEnd(rows), width }
    await exec(db, 'BEGIN IMMEDIATE; DROP TABLE IF EXISTS "' + parsed.tableName + '"; ' + datasetMap.createTableStatement(parsed.tableName, width))
    for (let i = 0; i < rows.length; i++) {
        const values = datasetMap.rowToRecord(rows[i], layout, i)
        await new Promise((resolve, reject) => db.run('INSERT INTO "' + parsed.tableName + '" VALUES (' + values.map(() => '?').join(',') + ')', values, err => err ? reject(err) : resolve()))
    }
    await exec(db, 'COMMIT')
    const jsonLocation = path.resolve(storageRoot, relative)
    fs.mkdirSync(path.dirname(jsonLocation), { recursive: true })
    fs.writeFileSync(jsonLocation, JSON.stringify(rows))
}

function expectBody(response, rows) {
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual(rows)
    expect(response.headers['ETag']).toBeTruthy()
    expect(response.headers['Access-Control-Expose-Headers']).toBe('ETag')
}

beforeEach(() => {
    fs.mkdirSync(tempParent, { recursive: true })
    root = fs.mkdtempSync(path.join(tempParent, 'storage-regression-'))
    routes = []
    writers = new Map()
    reads = opens = openReaders = peakReaders = 0
    afterSchema = afterSelect = failRead = undefined
    driver = {
        OPEN_READONLY: sqlite3.OPEN_READONLY,
        Database: function (location, flags, callback) {
            opens++
            openReaders++
            peakReaders = Math.max(peakReaders, openReaders)
            const db = new sqlite3.Database(location, flags, callback)
            const originalGet = db.get.bind(db)
            db.get = (sql, params, done) => originalGet(sql, params, async (err, row) => {
                try {
                    if (!err && sql.includes('sqlite_master') && afterSchema) { await afterSchema() }
                    done(err, row)
                } catch (error) { done(error) }
            })
            const originalAll = db.all.bind(db)
            db.all = function (sql, done) {
                reads++
                ;(async () => {
                    if (failRead) { throw failRead }
                    originalAll(sql, async (err, rows) => {
                        try {
                            if (!err && afterSelect) { await afterSelect() }
                            done(err, rows)
                        } catch (error) { done(error) }
                    })
                })().catch(done)
                return db
            }
            const originalClose = db.close.bind(db)
            db.close = done => originalClose(err => {
                openReaders--
                done(err)
            })
            return db
        }
    }
    global.SA = {
        nodeModules: { fs, sqlite3: driver },
        logger: { error() {}, warn() {} },
        projects: { foundations: { utilities: { httpResponses: newFoundationsUtilitiesHttpResponses() } } }
    }
    global.env = { PATH_TO_DATA_STORAGE: root, DATA_STORAGE_BACKEND: 'sqlite' }
    route = newStorageRoute()
    routes.push(route)
})

afterEach(async () => {
    await Promise.all(routes.map(item => item.finalize()))
    await Promise.all(Array.from(writers.values()).map(close))
    fs.rmSync(root, { recursive: true, force: true })
    global.SA = originalSA
    global.env = originalEnv
})

test('isolates products, timeframes, dates and markets, sequentially and concurrently', async () => {
    const fixtures = [
        [dataset(), [[1, 2, 3]]],
        [dataset('Volumes'), [[4, 5, 6]]],
        [dataset('Candles', '04-hs'), [[7, 8, 9]]],
        [dataset('Candles', '40-min', 'BTC-USDT', '2026/08/08'), [[10, 11, 12]]],
        [dataset('Candles', '40-min', 'BTC-USDT', '2026/08/09'), [[13, 14, 15]]],
        [dataset('Candles', '01-hs', 'ETH-USDT'), [[16, 17, 18]]]
    ]
    for (const [relative, rows] of fixtures) { await put(relative, rows) }
    const etags = new Set()
    for (const [relative, rows] of fixtures) {
        const response = await request(relative)
        expectBody(response, rows)
        etags.add(response.headers['ETag'])
    }
    expect(etags.size).toBe(fixtures.length)
    const firstReads = reads
    await Promise.all(Array.from({ length: 4 }, () => fixtures).flat().map(async ([relative, rows]) => {
        expectBody(await request(relative), rows)
    }))
    expect(reads).toBe(firstReads) // Warm requests do not materialize full tables.
    expect(opens).toBe(2) // One persistent reader per database, not per request.
})

test('returns 304 only for the same unchanged resource, and rejects old broken tags', async () => {
    await put(dataset(), [[111]])
    await put(dataset('Volumes'), [[222]])
    const first = await request(dataset())
    const unchanged = await request(dataset(), first.headers['ETag'])
    expect(unchanged.status).toBe(304)
    expect(unchanged.body).toBe('')
    expect(unchanged.headers['ETag']).toBe(first.headers['ETag'])
    expectBody(await request(dataset('Volumes'), first.headers['ETag']), [[222]])
    expectBody(await request(dataset(), '"sqlite:2"'), [[111]])
})

test('preserves missing-table 404 after warm reads, and invalidates a dropped table', async () => {
    await put(dataset(), [[111]])
    const first = await request(dataset())
    let missing = await request(dataset('Missing'), first.headers['ETag'])
    expect(missing.status).toBe(404)
    expect(missing.body).toBe('The specified key does not exist.\n')
    const { db, parsed } = await writer(dataset())
    await exec(db, 'DROP TABLE "' + parsed.tableName + '"')
    missing = await request(dataset(), first.headers['ETag'])
    expect(missing.status).toBe(404)
    await put(dataset(), [[333]])
    expectBody(await request(dataset(), first.headers['ETag']), [[333]])
})

test('invalidates same-row-count WAL commits even when the main database file is unchanged', async () => {
    await put(dataset(), [[111], [112]])
    const first = await request(dataset())
    const { location } = await writer(dataset())
    const before = fs.statSync(location)
    await put(dataset(), [[221], [222]])
    const after = fs.statSync(location)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    const changed = await request(dataset(), first.headers['ETag'])
    expectBody(changed, [[221], [222]])
    expect(changed.headers['ETag']).not.toBe(first.headers['ETag'])
})

test('preserves mixed cells, daily candle layout, duplicate timestamps and empty tables', async () => {
    const rows = [
        [2281.27, 2306.6, 2281.87, 2293.02, 1704067200000, 1704077999999],
        [2281.27, 2306.6, 2281.87, 2294.02, 1704067200000, 1704077999999]
    ]
    await put(dataset(), rows)
    expectBody(await request(dataset()), rows)
    const mixed = [[1, 'quote"\n\\', true, false, null, { value: [1, 2] }]]
    await put(dataset('Mixed'), mixed)
    expectBody(await request(dataset('Mixed')), mixed)
    await put(dataset('Empty'), [])
    expectBody(await request(dataset('Empty')), [])
})

test('never caches a snapshot under a revision changed by a concurrent writer', async () => {
    await put(dataset(), [[111]])
    afterSelect = async () => {
        afterSelect = undefined
        await put(dataset(), [[222]]) // Commit while the route holds its old WAL snapshot.
    }
    const raced = await request(dataset())
    expectBody(raced, [[111]])
    const fresh = await request(dataset(), raced.headers['ETag'])
    expectBody(fresh, [[222]])
    expect(fresh.headers['ETag']).not.toBe(raced.headers['ETag'])
})

test('handles a commit between pinning the snapshot and reading data_version', async () => {
    await put(dataset(), [[111]])
    afterSchema = async () => {
        afterSchema = undefined
        await put(dataset(), [[222]])
    }
    const raced = await request(dataset())
    expectBody(raced, [[111]])
    expectBody(await request(dataset(), raced.headers['ETag']), [[222]])
})

test('a commit during revalidation cannot return a stale 304', async () => {
    await put(dataset(), [[111]])
    const first = await request(dataset())
    afterSchema = async () => {
        afterSchema = undefined
        await put(dataset(), [[222]])
    }
    const raced = await request(dataset(), first.headers['ETag'])
    expectBody(raced, [[222]])
    expectBody(await request(dataset(), raced.headers['ETag']), [[222]])
})

test('bounds persistent readers and rotates tags when an evicted connection is reopened', async () => {
    await route.finalize()
    route = newStorageRoute({ maxSqliteReaders: 1 })
    routes.push(route)
    const a = dataset(), b = dataset('Candles', '01-hs', 'ETH-USDT')
    await put(a, [[111]])
    await put(b, [[222]])
    const first = await request(a)
    expectBody(await request(b), [[222]])
    const reopened = await request(a, first.headers['ETag'])
    expectBody(reopened, [[111]])
    expect(reopened.headers['ETag']).not.toBe(first.headers['ETag'])
    expect(peakReaders).toBe(1)
    const responses = await Promise.all([a, b, a, b].map(relative => request(relative)))
    responses.forEach((response, i) => expectBody(response, i % 2 === 0 ? [[111]] : [[222]]))
    expect(peakReaders).toBe(1)
})

test('idle retirement and route restart cannot validate an old browser tag', async () => {
    await route.finalize()
    route = newStorageRoute({ sqliteIdleMs: 20 })
    routes.push(route)
    await put(dataset(), [[111]])
    const first = await request(dataset())
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(openReaders).toBe(0)
    const reopened = await request(dataset(), first.headers['ETag'])
    expectBody(reopened, [[111]])
    expect(reopened.headers['ETag']).not.toBe(first.headers['ETag'])
    await route.finalize()
    route = newStorageRoute()
    routes.push(route)
    expectBody(await request(dataset(), reopened.headers['ETag']), [[111]])
})

test('isolates identical relative paths across storage roots', async () => {
    await put(dataset(), [[111]])
    const first = await request(dataset())
    const otherRoot = path.join(root, 'other-root')
    await put(dataset(), [[222]], otherRoot)
    global.env.PATH_TO_DATA_STORAGE = otherRoot
    const response = await request(dataset(), first.headers['ETag'])
    expectBody(response, [[222]])
    expect(response.headers['ETag']).not.toBe(first.headers['ETag'])
})

test('isolates JSON files with identical size and modification time, including deletion', async () => {
    global.env.DATA_STORAGE_BACKEND = 'json'
    await put(dataset(), [[111]])
    await put(dataset('Volumes'), [[222]])
    const time = new Date('2026-01-01T00:00:00Z')
    for (const relative of [dataset(), dataset('Volumes')]) {
        fs.utimesSync(path.join(root, relative), time, time)
    }
    const first = await request(dataset())
    expectBody(first, [[111]])
    const second = await request(dataset('Volumes'), first.headers['ETag'])
    expectBody(second, [[222]])
    expect(second.headers['ETag']).not.toBe(first.headers['ETag'])
    fs.unlinkSync(path.join(root, dataset()))
    expect((await request(dataset(), first.headers['ETag'])).status).toBe(404)
})

test('evicts bodies without mixing datasets when more than 100 resources are loaded', async () => {
    const fixtures = Array.from({ length: 105 }, (_, i) => [dataset('Product' + i), [[i]]])
    for (const [relative, rows] of fixtures) { await put(relative, rows) }
    for (const [relative, rows] of fixtures) { expectBody(await request(relative), rows) }
    const before = reads
    expectBody(await request(fixtures[0][0]), [[0]])
    expect(reads).toBe(before + 1)
})

test('replacement accounting stays bounded, and oversized bodies do not evict useful entries', async () => {
    const a = dataset(), b = dataset('Volumes'), oversized = dataset('Oversized')
    await put(a, [[1]])
    await put(b, [[2]])
    await put(oversized, [[999]])
    /* Simulate memory pressure without allocating hundreds of megabytes. */
    const byteLength = Buffer.byteLength
    const size = jest.spyOn(Buffer, 'byteLength').mockImplementation(body => {
        if (body === '[[1]]' || body === '[[2]]') { return 80 * 1024 * 1024 }
        if (body === '[[999]]') { return 257 * 1024 * 1024 }
        return byteLength(body)
    })
    try {
        expectBody(await request(a), [[1]])
        expectBody(await request(b), [[2]])
        const loaded = reads
        for (let i = 0; i < 6; i++) { expectBody(await request(a), [[1]]) }
        expectBody(await request(b), [[2]])
        expect(reads).toBe(loaded)
        expectBody(await request(oversized), [[999]])
        expectBody(await request(oversized), [[999]])
        expect(reads).toBe(loaded + 2)
        expectBody(await request(b), [[2]])
        expect(reads).toBe(loaded + 2)
    } finally { size.mockRestore() }
})

test('read failures return 503, release the reader, and recover on the next request', async () => {
    await put(dataset(), [[111]])
    failRead = Object.assign(new Error('test SQLITE_BUSY'), { code: 'SQLITE_BUSY' })
    expect((await request(dataset())).status).toBe(503)
    failRead = undefined
    expectBody(await request(dataset()), [[111]])
})

test('missing databases and paths outside the storage root return 404', async () => {
    expect((await request(dataset())).status).toBe(404)
    expect((await request('../package.json')).status).toBe(404)
})
