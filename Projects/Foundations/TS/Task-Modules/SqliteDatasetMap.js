/*
SqliteDatasetMap

Pure mapping helpers between Superalgos dataset file paths and SQLite storage.
This module has ZERO framework dependencies (no SA, TS or globals) so that it
can be required both by the task-process backend (SqliteBackend.js) and by the
standalone migration script (Platform/Migrate-Data-Storage.js).

Dataset file paths handled here look like this (relative to the storage root):

    Project/Data-Mining/Data-Mine/<mine>/<bot>/<exchange>/<market>/Output/<dataset...>/Data.json

They are stored in one SQLite file per mine + bot + exchange + market:

    Project/Data-Mining/Data-Mine/<mine>/<bot>/<exchange>/<market>.sqlite

with one table per dataset (bot + output path), holding rows shaped as:

    seq INTEGER PRIMARY KEY, begin INTEGER, end INTEGER, c0 TEXT, c1 TEXT, ...

Row layouts differ per dataset: market files look like [begin, end, ...],
daily candle files like [open, high, low, close, begin, end] and daily
volume files like [buy, sell, begin, end]. detectBeginEnd() locates the
timestamp pair per file; ALL original cells are then stored positionally in
c0..cn so the round trip is exact regardless of layout. begin / end are
indexed copies used for ordering; seq preserves file order (and keeps rows
with duplicate timestamps, which do occur in mined data).
*/
function isSqlitePath(filePath) {
    if (typeof filePath !== 'string') { return false }
    if (filePath.indexOf('Project/Data-Mining/') !== 0) { return false }
    if (filePath.indexOf('/bots/') >= 0) { return false }
    if (filePath.endsWith('/Data.json') === false) { return false }
    return true
}

function parseDatasetPath(filePath) {
    /*
    Returns { dbRelativePath, tableName, sourcePath } or undefined when the
    path does not have the expected dataset shape (caller must use JSON then).
    */
    if (isSqlitePath(filePath) === false) { return undefined }
    let parts = filePath.split('/')
    /* Need at least Project / Data-Mining / <mineType> / <mine> / <bot> /
    <exchange> / <market> / Output / <dataset...> / Data.json */
    if (parts.length < 10) { return undefined }
    if (parts[7] !== 'Output') { return undefined }

    let dbRelativePath = parts.slice(0, 7).join('/') + '.sqlite'
    let tableName = sanitizeTableName(parts.slice(4, parts.length - 1).join('/'))

    return {
        dbRelativePath: dbRelativePath,
        tableName: tableName,
        sourcePath: filePath
    }
}

function sanitizeTableName(pathFragment) {
    let name = 'd_' + pathFragment.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_')
    if (name.length <= 100) { return name }
    /* Long dataset paths: keep a readable prefix plus a hash suffix. */
    let hash = 5381
    for (let i = 0; i < pathFragment.length; i++) {
        hash = (((hash << 5) + hash) + pathFragment.charCodeAt(i)) >>> 0
    }
    return name.substring(0, 91) + '_' + hash.toString(16)
}

function tableWidth(rows) {
    let width = 0
    for (let i = 0; i < rows.length; i++) {
        if (Array.isArray(rows[i]) === true && rows[i].length > width) {
            width = rows[i].length
        }
    }
    return width
}

/*
Datasets do not share one row layout: market files are [begin, end, ...],
daily candle files are [open, high, low, close, begin, end], daily volume
files are [buy, sell, begin, end]. This scans the first rows for an
adjacent integer pair in epoch-millisecond range with end > begin and a
plausible duration, and returns its position. Returns { beginIndex: -1 }
when no timestamp pair is detectable (ordering then falls back to seq,
which always matches file order).
*/
function detectBeginEnd(rows) {
    const EPOCH_MS_MIN = 1000000000000
    const EPOCH_MS_MAX = 10000000000000
    const MAX_DURATION_MS = 366 * 86400 * 1000
    const SCAN_ROWS = 20
    let votes = {}
    let checked = 0
    for (let r = 0; r < rows.length && checked < SCAN_ROWS; r++) {
        let row = rows[r]
        if (Array.isArray(row) === false) { continue }
        checked++
        for (let i = 0; i + 1 < row.length; i++) {
            let begin = row[i]
            let end = row[i + 1]
            if (typeof begin !== 'number' || typeof end !== 'number') { continue }
            if (Number.isInteger(begin) === false || Number.isInteger(end) === false) { continue }
            if (begin < EPOCH_MS_MIN || begin > EPOCH_MS_MAX) { continue }
            if (end <= begin || end - begin > MAX_DURATION_MS) { continue }
            votes[i] = (votes[i] || 0) + 1
        }
    }
    let bestIndex = -1
    let bestVotes = 0
    for (let key of Object.keys(votes)) {
        if (votes[key] > bestVotes) {
            bestVotes = votes[key]
            bestIndex = parseInt(key, 10)
        }
    }
    if (bestIndex >= 0 && bestVotes >= Math.min(3, checked)) {
        return { beginIndex: bestIndex }
    }
    return { beginIndex: -1 }
}

function isLegacyTable(columns) {
    /* v1 tables were (begin INTEGER PRIMARY KEY, end INTEGER, cN...);
    v2 tables start with a seq column. */
    if (Array.isArray(columns) === false || columns.length === 0) { return false }
    return columns[0].name !== 'seq'
}

function createTableStatement(tableName, dataWidth) {
    let columns = ['seq INTEGER PRIMARY KEY', 'begin INTEGER', 'end INTEGER']
    for (let i = 0; i < dataWidth; i++) {
        columns.push('c' + i + ' TEXT')
    }
    return 'CREATE TABLE IF NOT EXISTS "' + tableName + '" (' + columns.join(', ') + ')'
}

function encodeCell(value) {
    if (value === undefined || value === null) { return null }
    return JSON.stringify(value)
}

function decodeCell(cell) {
    if (cell === undefined || cell === null) { return null }
    return JSON.parse(cell)
}

function normalizeValue(value) {
    if (value === undefined) { return null }
    return value
}

function rowToRecord(row, layout, seq) {
    /* layout = { beginIndex, width }. All original cells are stored
    positionally in c0..cn; begin / end are indexed copies (or null when
    the file layout carries no detectable timestamps). */
    let record = [seq, null, null]
    if (layout.beginIndex >= 0) {
        record[1] = normalizeValue(row[layout.beginIndex])
        record[2] = normalizeValue(row[layout.beginIndex + 1])
    }
    for (let i = 0; i < layout.width; i++) {
        record.push(encodeCell(row[i]))
    }
    return record
}

function recordToRow(record, dataWidth) {
    /* record is a node-sqlite3 row object keyed by column name
    ({ seq, begin, end, c0, c1, ... }); the returned array is positional
    to match the historical Data.json layout. */
    let row = []
    for (let i = 0; i < dataWidth; i++) {
        let value = record['c' + i]
        row.push(value === undefined ? null : decodeCell(value))
    }
    return row
}

module.exports = {
    isSqlitePath: isSqlitePath,
    parseDatasetPath: parseDatasetPath,
    sanitizeTableName: sanitizeTableName,
    tableWidth: tableWidth,
    detectBeginEnd: detectBeginEnd,
    isLegacyTable: isLegacyTable,
    createTableStatement: createTableStatement,
    rowToRecord: rowToRecord,
    recordToRow: recordToRow
}
