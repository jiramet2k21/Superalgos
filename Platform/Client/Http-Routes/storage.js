exports.newStorageRoute = function newStorageRoute() {
    const thisObject = {
        endpoint: 'Storage',
        command: command
    }

    return thisObject

    function command(httpRequest, httpResponse) {
        let pathToFile = httpRequest.url.substring(9)
        /* Unsaving # */
        for(let i = 0; i < 10; i++) {
            pathToFile = pathToFile.replace('_HASHTAG_', '#')
        }
        if (useSqliteBackend(pathToFile) === true) {
            serveDatasetFromSqlite(pathToFile, httpResponse)
            return
        }
        SA.projects.foundations.utilities.httpResponses.respondWithFile(global.env.PATH_TO_DATA_STORAGE + '/' + pathToFile, httpResponse)
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

    function serveDatasetFromSqlite(pathToFile, httpResponse) {
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
            db.all('SELECT * FROM "' + parsed.tableName + '" ORDER BY seq ASC', onRows)
        }

        function onRows(err, records) {
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
            let rows = []
            for (let i = 0; i < records.length; i++) {
                rows.push(datasetMap.recordToRow(records[i], width))
            }
            httpResponses.respondWithContent(JSON.stringify(rows), httpResponse)
        }
    }
}