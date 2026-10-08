
/* Callbacks default responses. */

let GLOBAL = {}

GLOBAL.DEFAULT_OK_RESPONSE = {
    result: "Ok",
    message: "Operation Succeeded"
}

GLOBAL.DEFAULT_FAIL_RESPONSE = {
    result: "Fail",
    message: "Operation Failed"
}

GLOBAL.DEFAULT_RETRY_RESPONSE = {
    result: "Retry",
    message: "Retry Later"
}

GLOBAL.CUSTOM_OK_RESPONSE = {
    result: "Ok, but check Message",
    message: "Custom Message"
}

GLOBAL.CUSTOM_FAIL_RESPONSE = {
    result: "Fail Because",
    message: "Custom Message"
}

let exports = {}

let browserCanvas                 // This is the canvas object of the browser.

function spacePad(str, max) {
    str = str.toString()
    return str.length < max ? spacePad(" " + str, max) : str
}

function loadSuperalgos() {

    const MODULE_NAME = "App Pre-Loader"
    const INFO_LOG = false

    let browser = checkBrowserVersion()
    setupHTMLTextArea()
    setupHTMLInput()
    setupHTMLCanvas()
    loadDebugModule()

    if ((browser.name !== "Chrome" && browser.name !== "Safari") || (browser.name === "Chrome" && parseInt(browser.version) < 85) || (browser.name === "Safari" && parseInt(browser.version) < 13)) {
        alert("Superalgos is officially supported on Google Chrome 85 or Safari 13.1 and above. Your browser version has been detected as potentially beneath this. If you continue you may experience some functionality issues.\n\nDetected Browser: " + browser.name + "\nVersion: " + browser.version)
    }

    function checkBrowserVersion() {

        let ua = navigator.userAgent, tem, M = ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) || []
        if (/trident/i.test(M[1])) {
            tem = /\brv[ :]+(\d+)/g.exec(ua) || []
            return { name: 'IE', version: (tem[1] || '') }
        }
        if (M[1] === 'Chrome') {
            tem = ua.match(/\bOPR|Edge\/(\d+)/)
            if (tem != null) { return { name: 'Opera', version: tem[1] } }
        }
        M = M[2] ? [M[1], M[2]] : [navigator.appName, navigator.appVersion, '-?']
        if ((tem = ua.match(/version\/(\d+)/i)) != null) { M.splice(1, 1, tem[1]) }
        return {
            name: M[0],
            version: M[1]
        }
    }

    function setupHTMLTextArea() {
        let textArea = document.createElement('textarea')
        textArea.id = "textArea"
        textArea.spellcheck = true
        textArea.style = 'resize: none;' +
            ' border: none;' +
            ' outline: none;' +
            'box-shadow: none;' +
            'overflow:hidden;' +
            'font-family: ' + 'Saira' + ';' +
            'font-size: 12px;' +
            'background-color: rgb(255, 255, 255);' +
            'color:rgb(255, 255, 255);' +
            'width: ' + 600 + 'px;' +
            'height: ' + 400 + 'px'

        let textAreaDiv = document.getElementById('textAreaDiv')
        textAreaDiv.appendChild(textArea)
        textAreaDiv.style = 'position:fixed; top:' + -1500 + 'px; left:' + 500 + 'px; z-index:10; '
    }

    function setupHTMLInput() {
        let input = document.createElement('input')
        input.id = "input"
        input.spellcheck = true
        input.style = "border: none; outline: none; box-shadow: none; overflow:hidden;  width: 0px; height: 0px;"

        let inputDiv = document.getElementById('inputDiv')
        inputDiv.appendChild(input)
    }

    function setupHTMLCanvas() {
        let canvas = document.createElement('canvas')

        canvas.id = "canvas"
        canvas.width = 1400
        canvas.height = 600
        canvas.style.border = "0"
        canvas.style = "position:absolute; top:0px; left:0px; z-index:1"

        let canvasApp = document.getElementById('canvasApp')
        canvasApp.appendChild(canvas)

        browserCanvas = document.getElementById('canvas')

        browserCanvas.width = window.innerWidth
        browserCanvas.height = window.innerHeight
        browserCanvas.style.border = "none"

        browserCanvas.style.top = 0 + 'px'
    }

    function loadDebugModule() {
        let path = "WebDebugLog.js"
        REQUIREJS([path], onRequired)

        function onRequired(pModule) {
            if (INFO_LOG === true) { console.log(spacePad(MODULE_NAME, 50) + " : " + "[INFO] " + path + " downloaded.") }
            loadModules()
        }
    }

    /* And Finally, we start loading all the scripts we will immediately need. */
    function loadModules() {
        let path = "AppLoader.js"
        REQUIREJS([path], onRequired)

        function onRequired(pModule) {
            if (INFO_LOG === true) { console.log(spacePad(MODULE_NAME, 50) + " : " + "[INFO] " + path + " downloaded.") }
            let APP_LOADER_MODULE = newAppLoader()
            APP_LOADER_MODULE.loadModules()
        }
    }
}

const HTTP_REQUEST_TIMEOUT_MS = 90000

function httpRequest(pContentToSend, pPath, callBackFunction) {
    let xmlHttpRequest = new XMLHttpRequest()
    /*
    Every terminal outcome below settles the callback exactly once. This
    used to handle only HTTP 200 and 404: any other outcome (HTTP 500 from
    an overloaded server, network errors, hung connections) never invoked
    the callback, leaked the caller's slot and left chart loaders waiting
    forever. Timeouts and network errors report 'XHR error' so upstream
    retry logic applies; other HTTP statuses fail fast without retrying.
    */
    let settled = false
    function settle(callBack) {
        if (settled === true) { return }
        settled = true
        callBack()
    }
    function fail(message) {
        settle(function () {
            callBackFunction({ result: "Fail", message: message })
        })
    }
    xmlHttpRequest.onreadystatechange = function () {
        if (this.readyState === 4 && this.status === 200) {
            try {
                let responseETag = null
                try {
                    responseETag = xmlHttpRequest.getResponseHeader('ETag')
                } catch (err) {
                    responseETag = null
                }
                settle(function () {
                    callBackFunction(GLOBAL.DEFAULT_OK_RESPONSE, xmlHttpRequest.responseText, responseETag)
                })
            } catch (err) {
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> err.stack = ' + err.stack)
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> pContentToSend = ' + pContentToSend)
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> pPath = ' + pPath)
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> xmlHttpRequest.responseText = ' + xmlHttpRequest.responseText)
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> callBackFunction = ' + callBackFunction)

            }
            return
        } else if (this.readyState === 4 && this.status === 304) {
            /*
            Conditional dataset read answered from the server cache
            (?etag= revalidation). The body lives in the caller's cache;
            surface the outcome distinctly so it can be served from there.
            */
            settle(function () {
                callBackFunction({ result: "Not-Modified", message: "Not Modified" })
            })
            return
        } else if (this.readyState === 4 && this.status === 404) {
            settle(function () {
                callBackFunction({ result: "Fail", message: xmlHttpRequest.responseText.trim(), code: xmlHttpRequest.responseText.trim() })
            })
            return
        } else if (this.readyState === 4) {
            fail('HTTP ' + this.status)
            return
        }
    }
    xmlHttpRequest.onerror = function () {
        fail('XHR error')
    }
    xmlHttpRequest.ontimeout = function () {
        fail('XHR error')
    }
    xmlHttpRequest.onabort = function () {
        fail('XHR error')
    }

    if (pContentToSend === undefined) {
        try {
            xmlHttpRequest.open("GET", pPath, true)
            xmlHttpRequest.timeout = HTTP_REQUEST_TIMEOUT_MS
            xmlHttpRequest.send()
        } catch (err) {
            fail(err.message)
        }
    } else {
        try {
            let blob = new Blob([pContentToSend], { type: 'text/plain' })
            xmlHttpRequest.open("POST", pPath, true)
            xmlHttpRequest.timeout = HTTP_REQUEST_TIMEOUT_MS
            xmlHttpRequest.send(blob)
        } catch (err) {
            if (ERROR_LOG === true) { console.log(spacePad(MODULE_NAME, 50) + " : " + "[ERROR] callServer -> err.message = " & err.message) }
            fail(err.message)
        }
    }
}

function httpRequestAsync(pContentToSend, pPath) {
    return new Promise((resolve, reject) => {
        let xmlHttpRequest = new XMLHttpRequest()

        function xhrSuccess() {
            if (xmlHttpRequest.readyState === 4) {
                if (xmlHttpRequest.status === 200) {
                    resolve({ result: 'Ok', message: xmlHttpRequest.responseText })
                } else {
                    reject({ result: 'Fail', message: xmlHttpRequest.responseText })
                }
            }
        }

        function xhrError() {
            reject({ result: 'Fail', message: xmlHttpRequest.responseText })
        }

        if (pContentToSend === undefined) {
            xmlHttpRequest.open("GET", pPath, true)
            xmlHttpRequest.timeout = HTTP_REQUEST_TIMEOUT_MS
            xmlHttpRequest.send()
            xmlHttpRequest.onload = xhrSuccess
            xmlHttpRequest.onerror = xhrError
            xmlHttpRequest.ontimeout = function () {
                reject({ result: 'Fail', message: 'XHR error' })
            }
        } else {
            let blob = new Blob([pContentToSend], { type: 'text/plain' })
            xmlHttpRequest.open("POST", pPath, true)
            xmlHttpRequest.timeout = HTTP_REQUEST_TIMEOUT_MS
            xmlHttpRequest.send(blob)
            xmlHttpRequest.onload = xhrSuccess
            xmlHttpRequest.onerror = xhrError
            xmlHttpRequest.ontimeout = function () {
                reject({ result: 'Fail', message: 'XHR error' })
            }
        }
    })
}

function httpCompressedRequest(pContentToSend, pPath, callBackFunction) {
    let xmlHttpRequest = new XMLHttpRequest()
    xmlHttpRequest.onreadystatechange = function () {
        if (this.readyState === 4 && this.status === 200) {
            try {
                callBackFunction(GLOBAL.DEFAULT_OK_RESPONSE, xmlHttpRequest.responseText)
            } catch (err) {
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> err.stack = ' + err.stack)
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> pContentToSend = ' + pContentToSend)
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> pPath = ' + pPath)
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> xmlHttpRequest.responseText = ' + xmlHttpRequest.responseText)
                console.log((new Date()).toISOString(), '[ERROR] httpRequest -> httpRequest -> callBackFunction = ' + callBackFunction)
            }
            return
        } else if (this.readyState === 4 && this.status === 404) {
            callBackFunction({ result: "Fail", message: xmlHttpRequest.responseText.trim(), code: xmlHttpRequest.responseText.trim() })
            return
        }
    }

    try {
        const compressed = new pako.deflate(pContentToSend);
        // let blob = new Blob(compressed, { type: 'text/plain' })
        xmlHttpRequest.open("POST", pPath, true)
        xmlHttpRequest.setRequestHeader('Content-Encoding', 'gzip')
        xmlHttpRequest.send(compressed)
    } catch (err) {
        if (ERROR_LOG === true) { console.log(spacePad(MODULE_NAME, 50) + " : " + "[ERROR] callServer -> err.message = " & err.message) }
        callBackFunction({ result: "Fail", message: err.message })
    }
}
