/*
Shared conditional-read cache for dataset revalidation (?etag=). Kept at
file scope so every loader instance in the page shares it (per-instance
state would defeat revalidation across chart inits). Storage URLs only:
the Platform /Storage/ route answers 304 + ETag for them. Bodies are
cached so a 304 can be served without a second round trip.
*/
const ETAG_CACHE_MAX_ENTRIES = 50
const ETAG_CACHE_MAX_BYTES = 64 * 1024 * 1024
let etagCache = new Map() // url -> { etag, body, bytes }
let etagCacheBytes = 0

function rememberEtag(url, etag, body) {
  if (etag === undefined || etag === null || body === undefined) { return }
  if (etagCache.has(url) === true) {
    etagCacheBytes -= etagCache.get(url).bytes
    etagCache.delete(url)
  }
  let bytes = body.length
  while ((etagCache.size >= ETAG_CACHE_MAX_ENTRIES || etagCacheBytes + bytes > ETAG_CACHE_MAX_BYTES) && etagCache.size > 0) {
    let oldest = etagCache.keys().next().value
    etagCacheBytes -= etagCache.get(oldest).bytes
    etagCache.delete(oldest)
  }
  etagCache.set(url, { etag: etag, body: body, bytes: bytes })
  etagCacheBytes += bytes
}

function etagFor(url) {
  let entry = etagCache.get(url)
  if (entry === undefined) { return undefined }
  return entry.etag
}

function cachedBodyFor(url) {
  let entry = etagCache.get(url)
  if (entry === undefined) { return undefined }
  /* LRU refresh. */
  etagCache.delete(url)
  etagCache.set(url, entry)
  return entry.body
}

function forgetEtag(url) {
  let entry = etagCache.get(url)
  if (entry === undefined) { return }
  etagCacheBytes -= entry.bytes
  etagCache.delete(url)
}

function newFileStorage(host, port, scheme='http') {
  const MODULE_NAME = 'File Storage'
  const INFO_LOG = false
  const logger = newWebDebugLog()


  const MAX_RETRY = 2
  let currentRetry = 0

  const recoverableErrors = [
    'SOCKETTIMEDOUT',
    'TIMEDOUT',
    'CONNRESET',
    'CONNREFUSED',
    'NOTFOUND',
    'ENOTFOUND',
    'ECONNREFUSED',
    'CONNREFUSED',
    'NOTFOUND',
    'ESOCKETTIMEDOUT',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN'
  ]

  let thisObject = {
    getFileFromHost: getFileFromHost
  }

  return thisObject

  async function getFileFromHost(filePath, callBackFunction, pathComplete) {
    try {
      if (INFO_LOG === true) { logger.write('[INFO] getFileFromHost -> Entering function.') }

      let folder = ''
      if (pathComplete === false || pathComplete === undefined) {
        folder = 'Storage/'
      }
      let url

      if (host !== undefined && port !== undefined) {
        url = scheme + '://' + host + ':' + port + '/' + folder + filePath
      } else {
        url = folder + filePath
      }

      /* Escaping # since it breaks the URL */
      url = url.replaceAll('#', '_HASHTAG_')

      /*
      Conditional read for datasets: when we hold an ETag for this exact
      URL, ask the server to revalidate instead of resending the body.
      Storage URLs only — other routes do not understand ?etag=. The
      cache key is the URL without the query string.
      */
      let cacheKey = url
      let isStorageUrl = (folder === 'Storage/')
      if (isStorageUrl === true) {
        let etag = etagFor(cacheKey)
        if (etag !== undefined) {
          url = url + '?etag=' + encodeURIComponent(etag)
        }
      }

      httpRequest(undefined, url, (response, fileContent, responseETag) => {
        if (response.result === GLOBAL.DEFAULT_OK_RESPONSE.result) {
          if (isStorageUrl === true) {
            rememberEtag(cacheKey, responseETag, fileContent)
          }
          callBackFunction(GLOBAL.DEFAULT_OK_RESPONSE, fileContent)
        } else if (response.result === 'Not-Modified' && isStorageUrl === true) {
          let cached = cachedBodyFor(cacheKey)
          if (cached !== undefined) {
            callBackFunction(GLOBAL.DEFAULT_OK_RESPONSE, cached)
          } else {
            /*
            Entry evicted between request and response: fetch cleanly
            without ?etag= (the server cannot 304 a request that carries
            no etag, so this terminates).
            */
            forgetEtag(cacheKey)
            getFileFromHost(filePath, callBackFunction, pathComplete)
          }
        } else {
          callBackFunction(response)
        }
      })
    } catch (err) {
      if (verifyRetry(err.code) && currentRetry < MAX_RETRY) {
        currentRetry++
        if (INFO_LOG === true) { console.log((new Date()).toISOString(), '[INFO] getTextFile -> Retrying connection to the server because received error: ' + err.code + '. Retry #: ' + currentRetry) }
        getFileFromHost(filePath, callBackFunction)
      } else if (err.message === 'Request aborted') {
        let err = { code: 'The specified key does not exist.' }
        callBackFunction(err)
      } else {
        console.log('Error getting the file from the server:', err)
        callBackFunction(GLOBAL.DEFAULT_FAIL_RESPONSE)
      }
    }
  }

  function verifyRetry(errorCode) {
    for (let i = 0; i < recoverableErrors.length; i++) {
      const error = recoverableErrors[i]
      if (error === errorCode) {
        return true
      }
    }
    return false
  }
}
