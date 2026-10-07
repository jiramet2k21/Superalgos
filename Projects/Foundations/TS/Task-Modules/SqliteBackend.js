exports.newSqliteBackend = function newSqliteBackend(processIndex) {

    const MODULE_NAME = 'SqliteBackend'
    const MAX_RETRY = 10
    const FAST_RETRY_TIME_IN_MILISECONDS = 500
    const SLOW_RETRY_TIME_IN_MILISECONDS = 2000
    const BUSY_TIMEOUT_MS = 30000

    const datasetMap = require('./SqliteDatasetMap.js')

    let sqlite3
    try {
        sqlite3 = SA.nodeModules.sqlite3
    } catch (err) {
        sqlite3 = undefined
    }
    if (sqlite3 === undefined) {
        try {
            sqlite3 = require('sqlite3')
        } catch (err) {
            sqlite3 = undefined
        }
    }

    let thisObject = {
        isAvailable: isAvailable,
        getTextFile: getTextFile,
        createTextFile: createTextFile,
        deleteDatasetFile: deleteDatasetFile
    }

    let logger
    try {
        logger = TS.projects.foundations.globals.loggerVariables.VARIABLES_BY_PROCESS_INDEX_MAP.get(processIndex).BOT_MAIN_LOOP_LOGGER_MODULE_OBJECT
        if (logger === undefined) { logger = dummyLogger() }
    } catch (err) {
        logger = dummyLogger()
    }

    function dummyLogger() {
        return { write: function () { } }
    }

    /* Serializes write operations per database file within this process so
    that two overlapping cycles can not interleave their transactions. */
    let writeQueues = {}

    return thisObject

    function isAvailable() {
        return sqlite3 !== undefined
    }

    function standardOk() {
        try {
            return TS.projects.foundations.globals.standardResponses.DEFAULT_OK_RESPONSE
        } catch (err) {
            return { result: 'Ok' }
        }
    }

    function standardFail() {
        try {
            return TS.projects.foundations.globals.standardResponses.DEFAULT_FAIL_RESPONSE
        } catch (err) {
            return { result: 'Fail' }
        }
    }

    function fileDoesNotExist() {
        let customResponse = {
            result: 'Custom Fail',
            message: 'File does not exist.'
        }
        try {
            customResponse.result = TS.projects.foundations.globals.standardResponses.CUSTOM_FAIL_RESPONSE.result
        } catch (err) {
            /* Keep the fallback shape. */
        }
        return customResponse
    }

    function getTextFile(filePath, callBackFunction, noRetry) {
        let parsed = datasetMap.parseDatasetPath(filePath)
        if (parsed === undefined || isAvailable() === false) {
            callBackFunction(fileDoesNotExist())
            return
        }

        let currentRetry = 0
        attemptRead()

        function attemptRead() {
            const fs = SA.nodeModules.fs
            let dbLocation = global.env.PATH_TO_DATA_STORAGE + '/' + parsed.dbRelativePath

            fs.access(dbLocation, onAccessChecked)

            function onAccessChecked(err) {
                if (err) {
                    if (noRetry === true) {
                        callBackFunction(fileDoesNotExist())
                        return
                    }
                    retryOrFail('Database file does not exist yet.')
                    return
                }
                readTable()
            }

            function readTable() {
                let db = new sqlite3.Database(dbLocation, sqlite3.OPEN_READONLY, onOpen)

                function onOpen(err) {
                    if (err) {
                        logger.write(MODULE_NAME, '[WARN] SqliteBackend -> getTextFile -> Could not open database -> db = ' + dbLocation)
                        retryOrFail(err)
                        return
                    }
                    /*
                    Rows are returned in seq order, which is the order the rows
                    had in the original Data.json file. That order is the
                    contract every consumer was built against, so the read is
                    byte-identical to the file it replaces.
                    */
                    db.all('SELECT * FROM "' + parsed.tableName + '" ORDER BY seq ASC', onRows)
                }

                function onRows(err, records) {
                    db.close()
                    if (err) {
                        /* Missing table reads as a missing file, like JSON does. */
                        if (err.message !== undefined && err.message.indexOf('no such table') >= 0) {
                            if (noRetry === true) {
                                callBackFunction(fileDoesNotExist())
                                return
                            }
                            retryOrFail('Table does not exist yet.')
                            return
                        }
                        retryOrFail(err)
                        return
                    }
                    let width = 0
                    for (let i = 0; i < records.length; i++) {
                        let keys = Object.keys(records[i])
                        /* Keys are seq, begin, end, c0..cn. */
                        if (keys.length - 3 > width) { width = keys.length - 3 }
                    }
                    let rows = []
                    for (let i = 0; i < records.length; i++) {
                        rows.push(datasetMap.recordToRow(records[i], width))
                    }
                    callBackFunction(standardOk(), JSON.stringify(rows))
                }
            }

            function retryOrFail(reason) {
                if (currentRetry < (noRetry === true ? 0 : MAX_RETRY)) {
                    currentRetry++
                    let retryTimeToUse = currentRetry > MAX_RETRY - 2 ? SLOW_RETRY_TIME_IN_MILISECONDS : FAST_RETRY_TIME_IN_MILISECONDS
                    logger.write(MODULE_NAME, '[WARN] SqliteBackend -> getTextFile -> Retrying -> Retry #: ' + currentRetry + ' -> reason = ' + reason)
                    setTimeout(attemptRead, retryTimeToUse)
                } else {
                    logger.write(MODULE_NAME, '[ERROR] SqliteBackend -> getTextFile -> Max retries reached -> file = ' + filePath)
                    callBackFunction(standardFail())
                }
            }
        }
    }

    function createTextFile(filePath, fileContent, callBackFunction) {
        let parsed = datasetMap.parseDatasetPath(filePath)
        if (parsed === undefined || isAvailable() === false) {
            callBackFunction(standardFail())
            return
        }

        let rows
        try {
            rows = JSON.parse(fileContent.toString())
        } catch (err) {
            logger.write(MODULE_NAME, '[ERROR] SqliteBackend -> createTextFile -> Content is not valid JSON -> file = ' + filePath)
            callBackFunction(standardFail())
            return
        }
        if (Array.isArray(rows) === false) {
            logger.write(MODULE_NAME, '[ERROR] SqliteBackend -> createTextFile -> Content is not an array -> file = ' + filePath)
            callBackFunction(standardFail())
            return
        }

        const fs = SA.nodeModules.fs
        const path = SA.nodeModules.path
        let dbLocation = global.env.PATH_TO_DATA_STORAGE + '/' + parsed.dbRelativePath

        try {
            fs.mkdirSync(path.dirname(dbLocation), { recursive: true })
        } catch (err) {
            logger.write(MODULE_NAME, '[ERROR] SqliteBackend -> createTextFile -> Could not create folders -> db = ' + dbLocation)
            callBackFunction(standardFail())
            return
        }

        /* Chain this write behind any pending write to the same database file. */
        let previous = writeQueues[dbLocation] || Promise.resolve()
        let current = previous.then(runWrite, runWrite)
        writeQueues[dbLocation] = current
        /* Avoid unhandled rejections and unbounded queue growth. */
        current.then(cleanupQueue, cleanupQueue)

        function cleanupQueue() {
            if (writeQueues[dbLocation] === current) {
                delete writeQueues[dbLocation]
            }
        }

        function runWrite() {
            return new Promise((resolve) => {
                let currentRetry = 0
                attemptWrite()

                function attemptWrite() {
                    let db = new sqlite3.Database(dbLocation, onOpen)

                    function onOpen(err) {
                        if (err) {
                            retryOrFail(err)
                            return
                        }
                        db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=' + BUSY_TIMEOUT_MS + '; PRAGMA synchronous=NORMAL;', onPragmas)
                    }

                    function onPragmas(err) {
                        if (err) {
                            closeAndRetry(err)
                            return
                        }
                        db.exec('BEGIN IMMEDIATE', onBegin)
                    }

                    function onBegin(err) {
                        if (err) {
                            closeAndRetry(err)
                            return
                        }
                        writeTransaction()
                    }

                    function writeTransaction() {
                        try {
                            let layout = datasetMap.detectBeginEnd(rows)
                            let dataWidth = datasetMap.tableWidth(rows)
                            layout.width = dataWidth
                            db.exec(datasetMap.createTableStatement(parsed.tableName, dataWidth), function (err) { onTableReady(layout, dataWidth, err) })
                        } catch (err) {
                            rollbackAndRetry(err)
                        }
                    }

                    function onTableReady(layout, dataWidth, err) {
                        if (err) {
                            rollbackAndRetry(err)
                            return
                        }
                        dropLegacyTableIfNeeded(layout, dataWidth)
                    }

                    function dropLegacyTableIfNeeded(layout, dataWidth) {
                        db.all('PRAGMA table_info("' + parsed.tableName + '")', onColumns)

                        function onColumns(err, columns) {
                            if (err) {
                                rollbackAndRetry(err)
                                return
                            }
                            if (datasetMap.isLegacyTable(columns) === true) {
                                /*
                                v1 layout (begin as PRIMARY KEY, no seq column):
                                it cannot hold every dataset shape, so it is
                                dropped and recreated in the v2 layout. The
                                source Data.json files are untouched, so
                                nothing is lost.
                                */
                                db.exec('DROP TABLE "' + parsed.tableName + '"', onDropped)
                                return
                            }
                            growColumnsIfNeeded(layout, dataWidth, columns)
                        }

                        function onDropped(err) {
                            if (err) {
                                rollbackAndRetry(err)
                                return
                            }
                            db.exec(datasetMap.createTableStatement(parsed.tableName, dataWidth), function (createErr) {
                                if (createErr) {
                                    rollbackAndRetry(createErr)
                                    return
                                }
                                replaceRows(layout, dataWidth)
                            })
                        }
                    }

                    function growColumnsIfNeeded(layout, dataWidth, columns) {
                        /* columns: seq, begin, end, c0..cn -> existing width is length - 3 */
                        let existingWidth = columns.length - 3
                            if (existingWidth < dataWidth) {
                                let next = existingWidth
                                addNextColumn()
                                function addNextColumn() {
                                    if (next >= dataWidth) {
                                        replaceRows(layout, dataWidth)
                                        return
                                    }
                                    db.exec('ALTER TABLE "' + parsed.tableName + '" ADD COLUMN c' + next + ' TEXT', onAdded)
                                    function onAdded(err) {
                                        if (err) {
                                            rollbackAndRetry(err)
                                            return
                                        }
                                        next++
                                        addNextColumn()
                                    }
                                }
                            } else {
                                replaceRows(layout, existingWidth > dataWidth ? existingWidth : dataWidth)
                            }
                        }

                    function replaceRows(layout, dataWidth) {
                        db.exec('DELETE FROM "' + parsed.tableName + '"', function (err) { onDeleted(layout, dataWidth, err) })
                    }

                    function onDeleted(layout, dataWidth, err) {
                        if (err) {
                            rollbackAndRetry(err)
                            return
                        }
                        if (rows.length === 0) {
                            updateMetaAndCommit(dataWidth)
                            return
                        }
                        let placeholders = ['?', '?', '?']
                        for (let i = 0; i < dataWidth; i++) { placeholders.push('?') }
                        let statement = db.prepare('INSERT INTO "' + parsed.tableName + '" VALUES (' + placeholders.join(', ') + ')', function (err) { onPrepared(layout, dataWidth, err, this) })
                    }

                    function onPrepared(layout, dataWidth, err, statement) {
                        if (err) {
                            rollbackAndRetry(err)
                            return
                        }
                        let index = 0
                        let sequence = 0
                        insertNext()

                        function insertNext() {
                            if (index >= rows.length) {
                                statement.finalize(onFinalized)
                                return
                            }
                            let record = datasetMap.rowToRecord(rows[index], layout, sequence)
                            statement.run(record, onRun)
                        }

                        function onRun(err) {
                            if (err) {
                                statement.finalize(function () {
                                    rollbackAndRetry(err)
                                })
                                return
                            }
                            index++
                            sequence++
                            insertNext()
                        }

                        function onFinalized(err) {
                            if (err) {
                                rollbackAndRetry(err)
                                return
                            }
                            updateMetaAndCommit(dataWidth)
                        }
                    }

                    function updateMetaAndCommit(dataWidth) {
                        db.exec('CREATE TABLE IF NOT EXISTS "_meta" (table_name TEXT PRIMARY KEY, source_path TEXT, width INTEGER, rows INTEGER, updated_at INTEGER)', onMetaTable)

                        function onMetaTable(err) {
                            if (err) {
                                rollbackAndRetry(err)
                                return
                            }
                            let meta = db.prepare('INSERT INTO "_meta" (table_name, source_path, width, rows, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(table_name) DO UPDATE SET source_path=excluded.source_path, width=excluded.width, rows=excluded.rows, updated_at=excluded.updated_at', function (err) { onMetaPrepared(err, this) })
                        }

                        function onMetaPrepared(err, statement) {
                            if (err) {
                                rollbackAndRetry(err)
                                return
                            }
                            statement.run([parsed.tableName, parsed.sourcePath, dataWidth, rows.length, Date.now()], onMetaRun.bind(null, statement))
                        }

                        function onMetaRun(statement, err) {
                            statement.finalize(function () {
                                if (err) {
                                    rollbackAndRetry(err)
                                    return
                                }
                                db.exec('COMMIT', onCommitted)
                            })
                        }

                        function onCommitted(err) {
                            db.close(function () {
                                if (err) {
                                    retryOrFail(err)
                                    return
                                }
                                logger.write(MODULE_NAME, '[INFO] SqliteBackend -> createTextFile -> fileLocation: ' + dbLocation + ' :: ' + parsed.tableName)
                                callBackFunction(standardOk())
                                resolve()
                            })
                        }
                    }

                    function rollbackAndRetry(err) {
                        db.exec('ROLLBACK', function () {
                            db.close(function () {
                                retryOrFail(err)
                            })
                        })
                    }

                    function closeAndRetry(err) {
                        db.close(function () {
                            retryOrFail(err)
                        })
                    }

                    function retryOrFail(err) {
                        if (currentRetry < MAX_RETRY) {
                            currentRetry++
                            let retryTimeToUse = currentRetry > MAX_RETRY - 2 ? SLOW_RETRY_TIME_IN_MILISECONDS : FAST_RETRY_TIME_IN_MILISECONDS
                            logger.write(MODULE_NAME, '[WARN] SqliteBackend -> createTextFile -> Retrying -> Retry #: ' + currentRetry + ' -> err = ' + (err && err.message ? err.message : err))
                            setTimeout(attemptWrite, retryTimeToUse)
                        } else {
                            logger.write(MODULE_NAME, '[ERROR] SqliteBackend -> createTextFile -> Max retries reached -> file = ' + filePath)
                            callBackFunction(standardFail())
                            resolve()
                        }
                    }
                }
            })
        }
    }

    function deleteDatasetFile(filePath, callBackFunction) {
        let parsed = datasetMap.parseDatasetPath(filePath)
        if (parsed === undefined || isAvailable() === false) {
            callBackFunction(standardFail())
            return
        }
        let dbLocation = global.env.PATH_TO_DATA_STORAGE + '/' + parsed.dbRelativePath
        let db = new sqlite3.Database(dbLocation, onOpen)

        function onOpen(err) {
            if (err) {
                callBackFunction(standardFail())
                return
            }
            db.exec('PRAGMA busy_timeout=' + BUSY_TIMEOUT_MS, onPragmas)
        }

        function onPragmas(err) {
            if (err) {
                db.close(function () {
                    callBackFunction(standardFail())
                })
                return
            }
            db.exec('DROP TABLE IF EXISTS "' + parsed.tableName + '"; DELETE FROM "_meta" WHERE table_name=\'' + parsed.tableName.replace(/'/g, "''") + '\'', onDropped)
        }

        function onDropped(err) {
            db.close(function () {
                if (err) {
                    callBackFunction(standardFail())
                    return
                }
                callBackFunction(standardOk())
            })
        }
    }
}
