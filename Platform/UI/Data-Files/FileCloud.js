
function newFileCloud () {
  const MODULE_NAME = 'File Cloud'
  const ERROR_LOG = true
  const logger = newWebDebugLog()
  

  /*
  This is the module in the system that actually connects to the cloud storage and grabs from there the needed files.
  */

  let thisObject = {
    getFile: getFile,
    initialize: initialize
  }

  let fileStorage

  /*
  Concurrency cap for the chart-load fan-out. Each chart pane fires one
  request per timeframe plus meta files, all at once, while the browser
  caps connections per host and the server threadpool saturates. Requests
  beyond the cap wait in a FIFO queue instead of piling up. Declared here,
  before the return, so the state is initialized during construction.
  */
  const MAX_CONCURRENT_FETCHES = 8
  let activeFetches = 0
  let fetchQueue = []

  return thisObject

  function enqueueFetch(fetchTask) {
    fetchQueue.push(fetchTask)
    pumpFetchQueue()
  }

  function pumpFetchQueue() {
    while (activeFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length > 0) {
      activeFetches++
      let fetchTask = fetchQueue.shift()
      fetchTask(releaseFetchSlot)
    }
  }

  function releaseFetchSlot() {
    if (activeFetches > 0) { activeFetches-- }
    pumpFetchQueue()
  }

  function initialize (pBot, pHost, pPort, scheme='http') {
    fileStorage = newFileStorage(pHost, pPort, scheme)
  }

  function getFile (pMine, pBot, pSession, pProduct, pDataset, pExchange, pMarket, ptimeFrameLabel, pDatetime, pSequence, pDataRange, pTimeFrames, callBackFunction) {
    try {
      const MAX_RETRIES = 3
      enqueueFetch(runFetch)

      function runFetch(release) {
        getFileRecursively(0, pMine, pBot, pSession, pProduct, pDataset, pExchange, pMarket, ptimeFrameLabel, pDatetime, pSequence, pDataRange, pTimeFrames, onFetchSettled)

        function onFetchSettled(err, data) {
          /* Every terminal path below calls back exactly once, so the slot is always released. */
          release()
          callBackFunction(err, data)
        }
      }

      function getFileRecursively (pRetryCounter, pMine, pBot, pSession, pProduct, pDataset, pExchange, pMarket, ptimeFrameLabel, pDatetime, pSequence, pDataRange, pTimeFrames, callBackFunction) {
        try {
          let fileName
          let filePath

          if (pDataRange === undefined && pTimeFrames === undefined) {
            fileName = pDataset.config.fileName
            filePath = pDataset.config.filePath
          } else {
            if (pDataRange !== undefined) {
              if (pDataset.config.dataRange !== undefined) {
                fileName = pDataset.config.dataRange.fileName
                filePath = pDataset.config.dataRange.filePath
              } else {
                let customErr = {
                  result: GLOBAL.CUSTOM_FAIL_RESPONSE.result,
                  message: 'Missing Configuration.'
                }
                if (ERROR_LOG === true) { logger.write('[WARN] getFile -> getFileRecursively -> onFileReceived -> customErr.message = ' + customErr.message) }
                if (ERROR_LOG === true) { logger.write('[WARN] getFile -> getFileRecursively -> onFileReceived -> Data Range configuration could not be found at Dataset ' + pDataset.name) }
                callBackFunction(customErr)
                return
              }
            }
            if (pTimeFrames !== undefined) {
              if (pDataset.config.timeFrames !== undefined) {
                if (pDataset.config.timeFrames.fileName !== '') {
                  fileName = pDataset.config.timeFrames.fileName
                  filePath = pDataset.config.timeFrames.filePath
                } else {
                  let customErr = {
                    result: GLOBAL.CUSTOM_FAIL_RESPONSE.result,
                    message: 'Configured to not Support This.'
                  }
                  callBackFunction(customErr)
                  return
                }
              } else {
                let customErr = {
                  result: GLOBAL.CUSTOM_FAIL_RESPONSE.result,
                  message: 'Missing Configuration.'
                }
                if (ERROR_LOG === true) { logger.write('[WARN] getFile -> getFileRecursively -> onFileReceived -> customErr.message = ' + customErr.message) }
                if (ERROR_LOG === true) { logger.write('[WARN] getFile -> getFileRecursively -> onFileReceived -> Time Frames configuration could not be found at Dataset ' + pDataset.name) }
                callBackFunction(customErr)
                return
              }
            }
          }

          if (fileName === undefined) {
            logger.write('[ERROR] getFile -> getFileRecursively -> Inconsistent data. Check the following: ')
            logger.write('[ERROR] getFile -> getFileRecursively -> pMine = ' + JSON.stringify(pMine))
            logger.write('[ERROR] getFile -> getFileRecursively -> pBot = ' + JSON.stringify(pBot))
            logger.write('[ERROR] getFile -> getFileRecursively -> pDataset = ' + JSON.stringify(pDataset))
            logger.write('[ERROR] getFile -> getFileRecursively -> pExchange = ' + JSON.stringify(pExchange))
            logger.write('[ERROR] getFile -> getFileRecursively -> pMarket = ' + JSON.stringify(pMarket))
            logger.write('[ERROR] getFile -> getFileRecursively -> ptimeFrameLabel = ' + JSON.stringify(ptimeFrameLabel))

            throw ('Inconsistent data received.')
          }

          if (pMarket !== undefined) {
            filePath = filePath.replace('@BaseAsset', pMarket.baseAsset)
            filePath = filePath.replace('@QuotedAsset', pMarket.quotedAsset)
          }

          if (pMine !== undefined) {
            filePath = filePath.replace('@MineType', pMine.type.replace(' ', '-'))
            filePath = filePath.replace('@Mine', pMine.config.codeName)
            filePath = filePath.replace('@Project', pMine.project)
          }

          if (pBot !== undefined) {
            filePath = filePath.replace('@Bot', pBot.config.codeName)
          }

          if (pSession !== undefined) {
            let config
            let sessionFolderName = pSession.type.replace(' ', '-').replace(' ', '-') + '-' + pSession.id    
            if (pSession.config !== undefined) {
              if (pSession.config.folderName !== undefined) {
                sessionFolderName = pSession.type.replace(' ', '-').replace(' ', '-') + '-' + pSession.config.folderName
              }
            }
            filePath = filePath.replace('@Session', sessionFolderName)
          }

          if (pExchange !== undefined) {
            filePath = filePath.replace('@Exchange', pExchange.config.codeName)
          }

          filePath = filePath.replace('@TimeFrame', ptimeFrameLabel)
          filePath = filePath.replace('@Dataset', pDataset.config.codeName)
          filePath = filePath.replace('@Product', pProduct.config.codeName)

          if (pDatetime !== undefined) {
            filePath = filePath.replace('@Year', pDatetime.getUTCFullYear())
            filePath = filePath.replace('@Month', pad(pDatetime.getUTCMonth() + 1, 2))
            filePath = filePath.replace('@Day', pad(pDatetime.getUTCDate(), 2))
            filePath = filePath.replace('@Hour', pad(pDatetime.getUTCHours(), 2))
            filePath = filePath.replace('@Minute', pad(pDatetime.getUTCMinutes(), 2))
          }

          if (pSequence !== undefined) {
            fileName = fileName.replace('@Sequence', pSequence)
          }

          fileStorage.getFileFromHost(filePath + '/' + fileName, onFileReceived)

          function onFileReceived (err, text, response) {
            try {
              let data

              if (err && err.result !== GLOBAL.DEFAULT_OK_RESPONSE.result) {
                if (err.code === 'BlobNotFound' || err.code === 'FileNotFound' || err.code === 'ParentNotFound' || err.code === 'The specified key does not exist.') {
                  let customErr = {
                    result: GLOBAL.CUSTOM_FAIL_RESPONSE.result,
                    message: 'File does not exist.'
                  }
                  callBackFunction(customErr)
                  return
                }

                if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> filePath = ' + filePath) }
                if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> fileName = ' + fileName) }
                if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> Unexpected Error Occurred.') }
                if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> err = ' + err.stack) }
                if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> text = ' + text) }
                if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> response = ' + response) }

                if (err.message === 'XHR error') {
                  if (pRetryCounter < MAX_RETRIES) {
                    if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> Retrying to get this file. ') }
                    if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> MAX_RETRIES = ' + MAX_RETRIES) }
                    if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> pRetryCounter = ' + pRetryCounter) }

                    getFileRecursively(pRetryCounter + 1, pMine, pBot, pSession, pProduct, pDataset, pExchange, pMarket, ptimeFrameLabel, pDatetime, pSequence, pDataRange, pTimeFrames, callBackFunction)
                    return
                  } else {
                    if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> Could not get this file from storage. ') }
                    if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> MAX_RETRIES = ' + MAX_RETRIES) }
                    if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> pRetryCounter = ' + pRetryCounter) }
                  }
                }

                callBackFunction(GLOBAL.DEFAULT_FAIL_RESPONSE)
                return
              } else {
                try {
                  data = JSON.parse(text)
                  callBackFunction(GLOBAL.DEFAULT_OK_RESPONSE, data)
                  return
                } catch (err) {
                  if (ERROR_LOG === true) { logger.write('[WARN] getFile -> getFileRecursively -> onFileReceived -> err = ' + err.stack) }
                  if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> filePath = ' + filePath) }
                  if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> fileName = ' + fileName) }

                  let customErr = {
                    result: GLOBAL.CUSTOM_OK_RESPONSE.result,
                    message: 'Data not in JSON Format.'
                  }

                  if (ERROR_LOG === true) { logger.write('[WARN] getFile -> getFileRecursively -> onFileReceived -> customErr.message = ' + customErr.message) }

                  callBackFunction(customErr, text)
                  return
                }
              }
            } catch (err) {
              if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> onFileReceived -> err = ' + err.stack) }
              callBackFunction(GLOBAL.DEFAULT_FAIL_RESPONSE)
            }
          }
        } catch (err) {
          if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> getFileRecursively -> err = ' + err.stack) }
          callBackFunction(GLOBAL.DEFAULT_FAIL_RESPONSE)
        }
      }
    } catch (err) {
      if (ERROR_LOG === true) { logger.write('[ERROR] getFile -> err = ' + err.stack) }
      callBackFunction(GLOBAL.DEFAULT_FAIL_RESPONSE)
    }
  }
}
