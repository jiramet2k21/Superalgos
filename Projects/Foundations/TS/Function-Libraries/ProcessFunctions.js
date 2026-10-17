exports.newFoundationsFunctionLibrariesProcessFunctions = function () {

    /*
    A bot main loop is not really a loop: it is a ping-pong of callbacks handed from stage to stage
    (initialize -> start -> execute -> finish -> loopControl). Every stage must invoke the callback it
    receives, otherwise the chain dies and, because the next setTimeout is only ever scheduled inside
    loopControl(), the process stays alive but silently stops doing any work at all.

    The stall watchdog is the safety net for that whole class of failure. It is re-armed by every
    heartbeat, so any real progress postpones it, and a heavy-but-healthy cycle is never a false
    positive. Only a chain that truly stopped calling back trips it.
    */
    const DEFAULT_STALL_WATCHDOG_TIMEOUT_MS = 1800000

    let thisObject = {
        processHeartBeat: processHeartBeat,
        processError: processError,
        processWarning: processWarning,
        processInfo: processInfo,
        stopProcess: stopProcess,
        failProcess: failProcess,
        armStallWatchdog: armStallWatchdog,
        clearStallWatchdog: clearStallWatchdog,
        getStallWatchdogTimeoutMs: getStallWatchdogTimeoutMs,
        getLoopPhaseOffsetMs: getLoopPhaseOffsetMs
    }

    return thisObject

    function getProcessVariables(processIndex) {
        return TS.projects.foundations.globals.processVariables.VARIABLES_BY_PROCESS_INDEX_MAP.get(processIndex)
    }

    function getStallWatchdogTimeoutMs(processIndex, defaultTimeoutMs) {
        /*
        The timeout can be tuned per process with config.cycleWatchdogTimeout (milliseconds).
        When it is not configured we fall back to defaultTimeoutMs, or to 30 minutes when the caller
        does not say otherwise. Passing 0 as the default leaves the process opted out: no timer is ever
        armed until someone sets the value in its configuration.
        Zero (or a negative/invalid value) always disables the watchdog.
        */
        let configured
        try {
            configured = TS.projects.foundations.globals.taskConstants.TASK_NODE.bot.processes[processIndex].referenceParent.config.cycleWatchdogTimeout
        } catch (err) {
            configured = undefined
        }
        if (configured === undefined || configured === null || configured === '') {
            return (defaultTimeoutMs === undefined) ? DEFAULT_STALL_WATCHDOG_TIMEOUT_MS : defaultTimeoutMs
        }
        const value = Number(configured)
        if (!isFinite(value) || value <= 0) { return 0 }
        return value
    }

    function rearmStallWatchdog(processIndex) {
        const processVariables = getProcessVariables(processIndex)
        if (processVariables === undefined || processVariables.STALL_WATCHDOG === undefined) { return }
        const watchdog = processVariables.STALL_WATCHDOG
        if (watchdog.timeoutMs <= 0) { return }
        if (watchdog.handle !== undefined) { clearTimeout(watchdog.handle) }
        watchdog.handle = setTimeout(watchdog.onStall, watchdog.timeoutMs)
    }

    function armStallWatchdog(processIndex, onStall, defaultTimeoutMs) {
        const processVariables = getProcessVariables(processIndex)
        if (processVariables === undefined) { return }
        clearStallWatchdog(processIndex)
        processVariables.STALL_WATCHDOG = {
            timeoutMs: getStallWatchdogTimeoutMs(processIndex, defaultTimeoutMs),
            handle: undefined,
            onStall: onStall
        }
        rearmStallWatchdog(processIndex)
    }

    function clearStallWatchdog(processIndex) {
        const processVariables = getProcessVariables(processIndex)
        if (processVariables === undefined || processVariables.STALL_WATCHDOG === undefined) { return }
        if (processVariables.STALL_WATCHDOG.handle !== undefined) {
            clearTimeout(processVariables.STALL_WATCHDOG.handle)
            processVariables.STALL_WATCHDOG.handle = undefined
        }
    }

    function failProcess(processIndex, callBackFunction, nextLoopTimeoutHandle, err) {
        /*
        Every branch that decides to abort a process must go through here, because stopProcess() only
        raises a visible error to the UI when UNEXPECTED_ERROR is set. When it is not set, stopProcess()
        reports a clean 'Stopped' and answers OK, which makes the caller log "execution finished
        successfully" for what was in fact a failure. failProcess() guarantees the error is always
        carried, synthesizing one when the caller could not provide details.
        */
        const processVariables = getProcessVariables(processIndex)
        if (processVariables === undefined) { return }
        if (processVariables.UNEXPECTED_ERROR === undefined) {
            processVariables.UNEXPECTED_ERROR = (err !== undefined && err !== null)
                ? err
                : new Error('The process reported a failure but did not provide any error details.')
        }
        stopProcess(processIndex, callBackFunction, nextLoopTimeoutHandle)
    }

    function stopProcess(processIndex, callBackFunction, nextLoopTimeoutHandle) {

        /* A process that is stopping does not need the stall watchdog anymore. */
        clearStallWatchdog(processIndex)

        /* Make sure that the logger associated to this process saves its cache */
        TS.projects.foundations.globals.loggerVariables.VARIABLES_BY_PROCESS_INDEX_MAP.get(processIndex).BOT_MAIN_LOOP_LOGGER_MODULE_OBJECT.persist()

        /* Cancel this process timeout */
        clearTimeout(nextLoopTimeoutHandle)

        let error = TS.projects.foundations.globals.processVariables.VARIABLES_BY_PROCESS_INDEX_MAP.get(processIndex).UNEXPECTED_ERROR

        if (error !== undefined) {
            /* 
            If the process is finishing with an error, we report it to the UI 
            and return to the process caller with a FAIL.
            
            If the docs object was created by an inner module, we will take it and 
            use it, otherwise we will consider this is a process level error and
            we will generate the docs object right here.
            */
            if (error.docs !== undefined) {

                TS.projects.foundations.functionLibraries.processFunctions.processError
                    (
                        TS.projects.foundations.globals.processVariables.VARIABLES_BY_PROCESS_INDEX_MAP.get(processIndex).PROCESS_KEY,
                        error.node,
                        error.message,
                        error.docs
                    )

            } else {
                let docs = {
                    project: 'Foundations',
                    category: 'Topic',
                    type: 'TS Process Error - Unexpected Error',
                    placeholder: {}
                }

                if (error.message !== undefined) {
                    docs.placeholder.errorMessage = {
                        style: 'Error',
                        text: error.message
                    }
                }
                if (error.stack !== undefined) {
                    docs.placeholder.errorStack = {
                        style: 'Javascript',
                        text: error.stack
                    }
                }
                if (error.code !== undefined) {
                    docs.placeholder.errorCode = {
                        style: 'Json',
                        text: error.code
                    }
                }
                docs.placeholder.errorDetails = {
                    style: 'Json',
                    text: JSON.stringify(error, undefined, 4)
                }

                TS.projects.foundations.functionLibraries.processFunctions.processError
                    (
                        TS.projects.foundations.globals.processVariables.VARIABLES_BY_PROCESS_INDEX_MAP.get(processIndex).PROCESS_KEY,
                        undefined,
                        "An unexpected error caused the Process to stop.",
                        docs
                    )

            }

            callBackFunction(TS.projects.foundations.globals.standardResponses.DEFAULT_FAIL_RESPONSE)
        } else {
            /*
            If the process did not finish with an error, we report to the UI that it stopped
            and return to the caller with OK.
            */
            TS.projects.foundations.globals.taskConstants.EVENT_SERVER_CLIENT_MODULE_OBJECT.raiseEvent(
                TS.projects.foundations.globals.processVariables.VARIABLES_BY_PROCESS_INDEX_MAP.get(processIndex).PROCESS_KEY, 'Stopped')

            callBackFunction(TS.projects.foundations.globals.standardResponses.DEFAULT_OK_RESPONSE)
        }
    }

    function processHeartBeat(processIndex, processingDate, percentage, status) {
        let event = {
            seconds: (new Date()).getSeconds(),
            processingDate: processingDate,
            percentage: percentage,
            status: status
        }
        const processVariables = getProcessVariables(processIndex)
        if (processVariables !== undefined) {
            processVariables.LAST_HEARTBEAT_AT = new Date()
        }
        TS.projects.foundations.globals.taskConstants.EVENT_SERVER_CLIENT_MODULE_OBJECT.raiseEvent(TS.projects.foundations.globals.processVariables.VARIABLES_BY_PROCESS_INDEX_MAP.get(processIndex).PROCESS_KEY, 'Heartbeat', event)
        /* Progress was just reported, so give the process a full stall window before declaring it stuck. */
        rearmStallWatchdog(processIndex)
    }

    function getLoopPhaseOffsetMs(pidOverride) {
        /*
        Returns a deterministic per-process phase offset (0 to 20000 ms) used to
        desynchronize bot main loops across simultaneously started tasks, so they
        do not stampede shared resources (CPU, exchange, disk) on every cycle.
        The offset derives from the OS process id: tasks launched together receive
        consecutive pids, which spreads their loops nearly one second apart. It
        reshuffles harmlessly across restarts. Pass pidOverride only for testing.
        */
        let pid
        if (pidOverride === undefined) {
            if (typeof process === 'undefined' || process.pid === undefined) { return 0 }
            pid = process.pid
        } else {
            pid = pidOverride
        }
        return (pid % 21) * 1000
    }

    function processError(processKey, node, errorMessage, docs) {
        let event
        if (node !== undefined) {
            event = {
                nodeName: node.name,
                nodeType: node.type,
                nodeId: node.id,
                errorMessage: errorMessage,
                docs: docs
            }
        } else {
            event = {
                errorMessage: errorMessage,
                docs: docs
            }
        }
        TS.projects.foundations.globals.taskConstants.EVENT_SERVER_CLIENT_MODULE_OBJECT.raiseEvent(processKey, 'Error', event)
    }

    function processWarning(processKey, node, warningMessage, docs) {
        let event
        if (node !== undefined) {
            event = {
                nodeName: node.name,
                nodeType: node.type,
                nodeId: node.id,
                warningMessage: warningMessage,
                docs: docs
            }
        } else {
            event = {
                warningMessage: warningMessage,
                docs: docs
            }
        }
        TS.projects.foundations.globals.taskConstants.EVENT_SERVER_CLIENT_MODULE_OBJECT.raiseEvent(processKey, 'Warning', event)
    }

    function processInfo(processKey, node, infoMessage, docs) {
        let event
        if (node !== undefined) {
            event = {
                nodeName: node.name,
                nodeType: node.type,
                nodeId: node.id,
                infoMessage: infoMessage,
                docs: docs
            }
        } else {
            event = {
                infoMessage: infoMessage,
                docs: docs
            }
        }
        TS.projects.foundations.globals.taskConstants.EVENT_SERVER_CLIENT_MODULE_OBJECT.raiseEvent(processKey, 'Info', event)
    }
}