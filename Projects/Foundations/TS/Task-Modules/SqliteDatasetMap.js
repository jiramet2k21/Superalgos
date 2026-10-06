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

    begin INTEGER PRIMARY KEY, end INTEGER, c0 TEXT, c1 TEXT, c2 TEXT, ...

Data columns are stored as the JSON encoding of each cell. SQLite has no
boolean type and normalizes some Javascript values, so encoding every cell
with JSON.stringify on write and JSON.parse on read is what guarantees that
JSON.stringify(rows) after a round trip is byte-identical to the original
file content, which is what every consumer expects. begin / end stay raw
numbers so ORDER BY begin keeps working.
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
    /* First two positions are always begin / end. */
    return Math.max(width - 2, 0)
}

function createTableStatement(tableName, dataWidth) {
    let columns = ['begin INTEGER PRIMARY KEY', 'end INTEGER']
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

function rowToRecord(row, dataWidth) {
    let record = [normalizeValue(row[0]), normalizeValue(row[1])]
    for (let i = 0; i < dataWidth; i++) {
        record.push(encodeCell(row[i + 2]))
    }
    return record
}

function recordToRow(record, dataWidth) {
    /* record is a node-sqlite3 row object keyed by column name
    ({ begin, end, c0, c1, ... }); the returned array is positional to
    match the historical Data.json layout. */
    let row = [
        record.begin === undefined ? null : record.begin,
        record.end === undefined ? null : record.end
    ]
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
    createTableStatement: createTableStatement,
    rowToRecord: rowToRecord,
    recordToRow: recordToRow
}
