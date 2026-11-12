const gBrowserLang = window.navigator.language.substring(0, 2);
const gDefaultPassword = "secret";
const gOpaqueId = "streaming-" + Janus.randomString(12);
const gOpaqueIdSend = "audiobridge-" + Janus.randomString(12);
const gMaxMediaAgeMs = 2000;
const gLang = (LANG.hasOwnProperty(gBrowserLang)) ? gBrowserLang : 'en';
const gLangTx = gLang;
const gMenuScrollTimoutMs = 150;
const gStatusPollTime = 5000;
const gDimVolume = 0.05;

// Connection recovery tuning
// Consecutive failed status polls before the signalling session is treated as lost
const gErrorMax = 3;
// A status poll with no answer after this long counts as failed
const gStatusPollTimeoutMs = 8000;
// Janus answers HTTP long-polls within 30s, so anything much longer is a dead connection
const gLongPollTimeoutMs = 40000;
// ICE "disconnected" often recovers by itself, so wait this long before acting
const gIceDisconnectGraceMs = 2000;
// How often to check that media packets are still arriving
const gWatchdogIntervalMs = 1000;
// No packets for this long while the source is live means the media path is stalled
const gMediaStallMs = 6000;
// Minimum time between recovery attempts on the same media path
const gRecoveryMinIntervalMs = 4000;
// A media path counts as healthy again after flowing for this long
const gHealthyResetMs = 10000;
// Backoff between attempts to create a new signalling session
const gSessionRetryMinMs = 1000;
const gSessionRetryMaxMs = 8000;
// Keep trying to reclaim an unreachable session for this long (server keeps it for JANUS_RECLAIM_TIMEOUT)
const gReclaimWindowMs = 30000;
// After this long without a session, reload or jump to the holding page
const gGiveUpAfterMs = 60000;
// Resume state saved across a reload is ignored after this long
const gResumeMaxAgeMs = 10 * 60 * 1000;
const gResumeKey = 'xlationResume';

let gSettings = {};

let gStatus = [];
let gMicList = [];
let gStatusUpdate = false;
let gPortrate = (window.innerHeight > window.innerWidth);

let gPlayIntention = false;
let gSendIntention = false;
let gMuteIntention = false;
let gPlaying = false;
let gVidPlaying = false;
let gSending = false;
let gPasswordsTx = {};

// One Janus session carries all plugin handles
let gJanus = null;
let gSessionGen = 0;
let gSessionReady = false;
let gSessionRecovery = null;
let gStreamingHandle = null;
let gVideoStreamingHandle = null;
let gSendMixerHandle = null;
let gAttachSeq = {rx: 0, video: 0, tx: 0};
let gRxWatchId = null;
let gVideoWatchId = null;
let gMyId = null;
let gStereo = false;
let gWebrtcUp = false;
let gMusicTx = false;
let gRemoteStream = null;
let gRemoteVidStream = null;
let gRemoteVidAudioStream = null;
let gRemoteRoomStream = null;
let gErrorCount = 0;
let gPollSeq = 0;
let gPollInFlightSince = 0;
let gLogMuted = false;
let gMedia = {rx: newMediaState(), video: newMediaState(), tx: newMediaState()};
let gNetworkType = (navigator.connection) ? navigator.connection.type : undefined;
let gResumePending = null;
let gUserHasScrolled = false;
let gHasScrolledTimer = null;
let gWakeLock = null;
let gAudioContext = null;
let gOscillator = null;
let gGainNode = null;


// Available debug outputs: "trace", "debug", "vdebug", "log", "warn", "error"
// Modifiy in local storage to set desired debug level in browser
// Also modify enableDebugPollStatus in local storage to enable or disable debugging of polling loop
let gDebugLevels = ["warn", "error"];
let gDebugBindStore = {};
if (!localStorage.debugLevels) {
    localStorage.debugLevels = JSON.stringify(gDebugLevels);
} else {
    try {
        gDebugLevels = JSON.parse(localStorage.debugLevels);
    } catch (err) {
        console.log(err, "Resetting default debug level");
        localStorage.debugLevels = JSON.stringify(gDebugLevels);
    }
}

window.onload = function() {
    runWithSettings(function() {
        if (!localStorage.micDeviceId) {
            localStorage.micDeviceId = 'default';
        }
        if (!localStorage.enableDebugPollStatus) {
            localStorage.enableDebugPollStatus = 'false';
        }
        loadResumeState();
        janusInit();
        updateDisplay();
        setInterval(timedPollStatus, gStatusPollTime);
        setInterval(mediaWatchdog, gWatchdogIntervalMs);
        // Listen for resize changes
        window.addEventListener("resize", function() {
            // Get screen size (inner/outerWidth, inner/outerHeight)
            const portrate = (window.innerHeight > window.innerWidth);
            if (portrate != gPortrate) {
                gPortrate = portrate;
                orientation();
            }
        }, false);
        orientation();

        // Handle page visibility changes to maintain audio playback
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Roaming between access points, or between WiFi and mobile data
        window.addEventListener('online', function() {
            networkChanged('browser is online');
        });
        window.addEventListener('offline', function() {
            Janus.warn("Browser reports it is offline");
            updateConnIndicator();
        });
        if (navigator.connection && navigator.connection.addEventListener) {
            navigator.connection.addEventListener('change', function() {
                // Only the network type is a reliable sign of a real change.
                // Bandwidth estimates also fire this event, constantly.
                const type = navigator.connection.type;
                if (type !== gNetworkType) {
                    gNetworkType = type;
                    networkChanged('network type now ' + type);
                }
            });
        }

        // Play silence on a loop when playing WebRTC audio to keep phone
        // alive when screen goes off.
        // Start/stop WebRTC when this player starts/stops.
        const silentPlayer = document.getElementById('silence');
        if (silentPlayer) {
            silentPlayer.addEventListener('play', function() {
                startPlay();
            });
            silentPlayer.addEventListener('pause', function() {
                stopPlay();
            })
        }
        const silentPlayerTx = document.getElementById('silenceTx');
        if (silentPlayerTx) {
            silentPlayerTx.addEventListener('play', function() {
                startSend();
            });
            silentPlayerTx.addEventListener('pause', function() {
                stopSend();
            })
        }
        const chSelectList = document.getElementById('chSelectList');
        chSelectList.onscroll = function(e) {
            scrollInputMaskTimer();
        };
        const chSelectListTx = document.getElementById('chSelectListTx')
        chSelectListTx.onscroll = function(e) {
            scrollInputMaskTimer();
        };
        const micSelectListTx = document.getElementById('micSelectListTx')
        micSelectListTx.onscroll = function(e) {
            scrollInputMaskTimer();
        };
    });
};

function scrollInputMaskTimer() {
    gUserHasScrolled = true;
    if (gHasScrolledTimer) {
        clearTimeout(gHasScrolledTimer);
        gHasScrolledTimer = null;
    }
    gHasScrolledTimer = setTimeout(function() {
        gUserHasScrolled = false;
        gHasScrolledTimer = null;
    }, gMenuScrollTimoutMs);
}

// Request Wake Lock to prevent screen from sleeping
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator && !gWakeLock) {
            gWakeLock = await navigator.wakeLock.request('screen');
            Janus.log('Wake Lock activated');
            gWakeLock.addEventListener('release', () => {
                Janus.log('Wake Lock released');
                gWakeLock = null;
            });
        }
    } catch (err) {
        Janus.warn('Wake Lock request failed:', err);
    }
}

// Release Wake Lock
function releaseWakeLock() {
    if (gWakeLock) {
        gWakeLock.release();
        gWakeLock = null;
    }
}

// Create silent Web Audio API oscillator to keep audio context alive
function createSilentOscillator() {
    try {
        if (!gAudioContext) {
            gAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            gOscillator = gAudioContext.createOscillator();
            gGainNode = gAudioContext.createGain();

            gOscillator.connect(gGainNode);
            gGainNode.connect(gAudioContext.destination);

            gGainNode.gain.value = 0.001; // Near-silent
            gOscillator.frequency.value = 20; // Sub-audible frequency
            gOscillator.start();
            Janus.log('Silent oscillator started');
        }
    } catch (err) {
        Janus.warn('Failed to create silent oscillator:', err);
    }
}

// Stop silent oscillator
function stopSilentOscillator() {
    try {
        if (gOscillator) {
            gOscillator.stop();
            gOscillator.disconnect();
            gOscillator = null;
        }
        if (gGainNode) {
            gGainNode.disconnect();
            gGainNode = null;
        }
        if (gAudioContext) {
            gAudioContext.close();
            gAudioContext = null;
        }
        Janus.log('Silent oscillator stopped');
    } catch (err) {
        Janus.warn('Error stopping silent oscillator:', err);
    }
}

// Handle visibility changes to maintain playback
function handleVisibilityChange() {
    if (!document.hidden) {
        Janus.log('Page became visible');
        // Re-request wake lock when page becomes visible
        if (gPlaying || gSending) {
            requestWakeLock();
        }
        // Resume audio playback if needed
        if (gPlaying) {
            const audioStream = document.getElementById('audioStream');
            if (audioStream && audioStream.paused) {
                audioStream.play().catch(err => {
                    Janus.warn('Failed to resume audio:', err);
                });
            }
            const silentPlayer = document.getElementById('silence');
            if (silentPlayer && silentPlayer.paused) {
                silentPlayer.play().catch(err => {
                    Janus.warn('Failed to resume silent player:', err);
                });
            }
        }
        if (gSending) {
            const silentPlayerTx = document.getElementById('silenceTx');
            if (silentPlayerTx && silentPlayerTx.paused) {
                silentPlayerTx.play().catch(err => {
                    Janus.warn('Failed to resume silent player TX:', err);
                });
            }
        }
        // The network may have changed while hidden, so check the connection now
        // rather than waiting for the next poll
        checkConnectionHealth('page became visible');
    } else {
        Janus.log('Page became hidden');
    }
}

// Remember what the user was doing so that it can be offered back after a reload
function saveResumeState() {
    if (gPlayIntention || gSendIntention) {
        try {
            sessionStorage.setItem(gResumeKey, JSON.stringify({
                play: gPlayIntention,
                send: gSendIntention,
                mute: gMuteIntention,
                time: Date.now()
            }));
        } catch (err) {
            Janus.warn("Could not save resume state", err);
        }
    }
}

function loadResumeState() {
    try {
        const stored = sessionStorage.getItem(gResumeKey);
        sessionStorage.removeItem(gResumeKey);
        if (stored) {
            const state = JSON.parse(stored);
            if (state && (Date.now() - state.time < gResumeMaxAgeMs) && (state.play || state.send)) {
                gResumePending = state;
            }
        }
    } catch (err) {
        Janus.warn("Could not load resume state", err);
    }
}

// Browsers will not start audio after a reload without a user gesture,
// so offer a single tap to pick up where the user left off
function offerResume() {
    if (!gResumePending || document.getElementById('resumeBox')) {
        return;
    }
    const resume = gResumePending;
    const playOk = resume.play && channelLive(localStorage.channel);
    const sendOk = resume.send && !gHideMic && channelTxValid(localStorage.channelTx);
    if (!playOk && !sendOk) {
        return;
    }
    gResumePending = null;
    const box = document.createElement('div');
    box.id = 'resumeBox';
    box.className = 'resumeBox';
    const button = document.createElement('button');
    button.className = 'resumeBtn';
    button.innerText = langText(gLang, sendOk ? 'tap to resume broadcast' : 'tap to resume');
    box.appendChild(button);
    box.addEventListener('click', function(event) {
        event.stopPropagation();
        box.remove();
        if (playOk && !gPlayIntention) {
            clickPlayerEnact();
        }
        if (sendOk && !gSendIntention) {
            gMuteIntention = !!resume.mute;
            clickSenderStartMuteEnact();
        }
    });
    document.body.appendChild(box);
}

function langText(lang, key) {
    if (LANG[lang] && LANG[lang][key]) {
        return LANG[lang][key];
    }
    return LANG.en[key] || key;
}

function jumpBack(onStay) {
    if (gSettings.timeoutUrl !== false) {
        // Only leave if the holding page can be reached, otherwise the user
        // is left on a browser error page that will never recover
        fetch(gSettings.timeoutUrl, {
            mode: "no-cors",
            cache: "no-store"
        }).then(function() {
            window.location.href = gSettings.timeoutUrl;
        }).catch(function() {
            Janus.warn("Holding page not reachable, staying put");
            if (onStay) {
                onStay();
            }
        });
    } else if (onStay) {
        onStay();
    } else {
        window.location.reload();
    }
}

// If we have lost the server then reload, or jump to holding page if it is set.
// onStay is called if neither is possible, e.g. no network at all.
function reloadOrJumpBack(onStay) {
    saveResumeState();
    fetch("index.html", {
        cache: "no-store"
    }).then(function(response) {
        return response.text();
    }).then(function(html) {
        if (html.includes("Translation Web Client")) {
            // Reload page if it exists
            window.location.reload();
        } else {
            jumpBack(onStay);
        }
    }).catch(function(err) {
        jumpBack(onStay);
    });
}

function getMicDeviceId(callback) {
    let micDeviceId = 'default';
    Janus.listDevices(function(micDevices) {
        gMicList = JSON.parse(JSON.stringify(micDevices));
        // Check if any stored mic device ID exists before trying to use it
        if (localStorage.micDeviceId) {
            micDevices.forEach(function(device) {
                if (device.deviceId && (localStorage.micDeviceId === device.deviceId)) {
                    micDeviceId = device.deviceId;
                }
            }, {
                audio: true,
                video: false
            });
        }
        localStorage.micDeviceId = micDeviceId;
        callback(micDeviceId)
    }, {
        audio: true,
        video: false
    })
}

function getMicTrack(callback) {
    getMicDeviceId(function(micDeviceId) {
        let track = {
            type: 'audio',
            mid: '0',
            capture: {
                autoGainControl: true,
                latency: 0,
                echoCancellation: !gMusicTx,
                noiseSuppression: !gMusicTx,
            },
            recv: true
        };
        if (micDeviceId.toLowerCase() !== 'default') {
            track.deviceId = {
                exact: micDeviceId
            };
        }
        callback(track);
    });
}

function updateLiveMic() {
    getMicTrack(function(track) {
        gSendMixerHandle.replaceTracks({
            tracks: [track],
            error: function(err) {
                Janus.error("Error when changing Mic : ", err);
            }
        });
    });
}

// Stand-in for the audiobridge handle when the translator panel is hidden
// or while the real handle is being (re)attached
function fakeSendMixerHandle() {
    return {
        fake: true,
        send: function(params) {
            if (params && typeof params.success === 'function') {
                params.success({
                    "list": []
                });
            }
        }
    };
}

function isRealHandle(handle) {
    return !!(handle && !handle.fake && typeof handle.getId === 'function');
}

function janusInit() {
    gSendMixerHandle = fakeSendMixerHandle();
    Janus.init({
        debug: gDebugLevels,
        callback: function() {
            if (!Janus.isWebrtcSupported()) {
                Janus.error("No WebRTC support");
                return;
            }
            janusConnect();
        }
    });
}

// Signalling servers in order of preference. janus.js uses the first one that works.
function janusServers() {
    let servers = [];
    if (gSettings.wsProxy) {
        // WebSockets proxied by the web server on the same host and port as the page
        const url = new URL(gSettings.wsProxyPath || "janus-ws", window.location.href);
        url.protocol = (window.location.protocol === "https:") ? "wss:" : "ws:";
        servers.push(url.href);
    }
    switch (gSettings.ws) {
        case 'ws':
            servers.push("ws://" + window.location.hostname + ":8188");
            break;
        case 'wss':
            servers.push("wss://" + window.location.hostname + ":8989");
            break;
    }
    // REST API long-polling as the last resort
    servers.push("janus");
    return servers;
}

function janusConnect() {
    const gen = ++gSessionGen;
    gSessionReady = false;
    resetHandles();
    gJanus = new Janus({
        server: janusServers(),
        iceServers: gSettings.iceServers,
        longPollTimeout: gLongPollTimeoutMs,
        success: function() {
            if (gen !== gSessionGen) return;
            Janus.log("Janus session created");
            attachHandles(gen);
        },
        error: function(error) {
            if (gen !== gSessionGen) return;
            Janus.error("Janus session error:", error);
            sessionLost("session error: " + error);
        },
        destroyed: function() {
            if (gen !== gSessionGen) return;
            Janus.warn("Janus session destroyed");
            sessionLost("session destroyed");
        }
    });
}

function resetHandles() {
    gStreamingHandle = null;
    gVideoStreamingHandle = null;
    gSendMixerHandle = fakeSendMixerHandle();
    gWebrtcUp = false;
    for (let path in gAttachSeq) {
        gAttachSeq[path]++;
    }
}

function attachHandles(gen) {
    let pending = (gHideMic) ? 1 : 3;
    const attached = function() {
        pending--;
        if (pending === 0 && gen === gSessionGen) {
            gSessionReady = true;
            sessionRecovered();
            pollStatus();
            restoreMedia();
        }
    };
    attachStreaming('rx', gen, attached);
    if (!gHideMic) {
        attachStreaming('video', gen, attached);
        attachAudiobridge(gen, attached);
    }
}

// After a new session, put back whatever the user had running
function restoreMedia() {
    for (let path in gMedia) {
        resetMediaState(path);
    }
    if (gPlaying) {
        loadAudio();
    }
    if (gSending) {
        loadSendRoom();
    }
}

// Something is badly wrong with the signalling session: reclaim it or replace it
function sessionLost(reason) {
    gSessionReady = false;
    updateConnIndicator();
    if (!gSessionRecovery) {
        Janus.warn("Signalling session lost (" + reason + "), recovering");
        gSessionRecovery = {
            startMs: Date.now(),
            delayMs: gSessionRetryMinMs,
            timer: null,
            next: null,
            busy: false
        };
        updateConnIndicator();
        attemptSessionRecovery();
    } else if (!gSessionRecovery.timer && !gSessionRecovery.busy) {
        // The attempt in progress has failed
        scheduleNewSession();
    }
}

function attemptSessionRecovery() {
    const rec = gSessionRecovery;
    const janus = gJanus;
    const gen = gSessionGen;
    // A session that janus.js has given up on can be reclaimed, keeping all handles,
    // if the server has not timed it out yet
    if (janus && janus.getSessionId() && !janus.isConnected()) {
        Janus.log("Trying to reclaim Janus session " + janus.getSessionId());
        rec.busy = true;
        janus.reconnect({
            success: function() {
                rec.busy = false;
                if (gen !== gSessionGen || gSessionRecovery !== rec) return;
                Janus.log("Janus session reclaimed");
                gSessionReady = true;
                sessionRecovered();
                pollStatus();
                // The network has probably changed underneath the media, so refresh it
                for (let path in gMedia) {
                    if (mediaWanted(path)) {
                        resetMediaState(path);
                        recoverMedia(path, "session reclaimed");
                    }
                }
            },
            error: function(error) {
                rec.busy = false;
                if (gen !== gSessionGen || gSessionRecovery !== rec) return;
                Janus.warn("Could not reclaim session: " + error);
                // If the server could not be reached at all, the session is probably still
                // there waiting for us, so keep trying to claim it for a while
                const serverForgotUs = /no such session/i.test(String(error));
                if (!serverForgotUs && (Date.now() - rec.startMs < gReclaimWindowMs)) {
                    recoveryWait(rec, attemptSessionRecovery);
                } else {
                    scheduleNewSession();
                }
            }
        });
    } else {
        scheduleNewSession();
    }
}

// Run the next recovery step after the current backoff delay
function recoveryWait(rec, next) {
    Janus.log("Next connection attempt in " + rec.delayMs + "ms");
    rec.next = next;
    rec.timer = setTimeout(function() {
        rec.timer = null;
        if (gSessionRecovery !== rec) return;
        next();
    }, rec.delayMs);
    rec.delayMs = Math.min(rec.delayMs * 2, gSessionRetryMaxMs);
}

function scheduleNewSession() {
    const rec = gSessionRecovery;
    if (!rec || rec.timer || rec.busy) {
        return;
    }
    discardSession();
    if (Date.now() - rec.startMs > gGiveUpAfterMs) {
        giveUp();
        return;
    }
    recoveryWait(rec, janusConnect);
}

// Skip the backoff, e.g. when the network has just come back
function retrySessionNow() {
    const rec = gSessionRecovery;
    if (rec && rec.timer && rec.next) {
        clearTimeout(rec.timer);
        rec.timer = null;
        rec.delayMs = gSessionRetryMinMs;
        rec.next();
    }
}

function giveUp() {
    const rec = gSessionRecovery;
    Janus.warn("Could not recover the connection, reloading");
    rec.busy = true;
    reloadOrJumpBack(function() {
        // Nowhere to go, so carry on trying from here
        rec.busy = false;
        rec.startMs = Date.now();
        scheduleNewSession();
    });
}

// Drop the current session locally without waiting on a network that may be dead
function discardSession() {
    const janus = gJanus;
    gSessionGen++;
    gJanus = null;
    gSessionReady = false;
    gPollInFlightSince = 0;
    janusLogMute(false);
    clearRemoteMedia();
    resetHandles();
    if (janus) {
        try {
            janus.destroy({
                unload: true,
                notifyDestroyed: false,
                cleanupHandles: true
            });
        } catch (err) {
            Janus.warn("Error discarding old session", err);
        }
    }
}

function sessionRecovered() {
    if (gSessionRecovery && gSessionRecovery.timer) {
        clearTimeout(gSessionRecovery.timer);
    }
    gSessionRecovery = null;
    gErrorCount = 0;
    updateConnIndicator();
}

function clearRemoteMedia() {
    gRemoteStream = null;
    gRemoteVidStream = null;
    gRemoteVidAudioStream = null;
    gRemoteRoomStream = null;
}

function newMediaState() {
    return {
        iceTimer: null,
        attempts: 0,
        lastAttemptMs: 0,
        lastPackets: -1,
        lastPacketsChangeMs: 0,
        healthySinceMs: 0
    };
}

function resetMediaState(path) {
    const m = gMedia[path];
    if (m.iceTimer) {
        clearTimeout(m.iceTimer);
    }
    gMedia[path] = newMediaState();
    // Give a new connection time to get going before the watchdog judges it
    gMedia[path].lastPacketsChangeMs = Date.now();
}

function mediaHandle(path) {
    switch (path) {
        case 'rx':
            return gStreamingHandle;
        case 'video':
            return gVideoStreamingHandle;
        default:
            return gSendMixerHandle;
    }
}

function mediaPc(path) {
    const handle = mediaHandle(path);
    return (isRealHandle(handle) && handle.webrtcStuff) ? handle.webrtcStuff.pc : null;
}

function mediaWanted(path) {
    switch (path) {
        case 'rx':
            return gPlaying;
        case 'video':
            return gVidPlaying;
        default:
            return gSending;
    }
}

function mediaSourceLive(path) {
    if (path === 'rx') {
        return channelLive(localStorage.channel);
    }
    const channel = channelNumberLookup('Video Channel');
    return (channel >= 0) && !!gStatus[channel].videoValid;
}

function mediaRecovering(path) {
    const m = gMedia[path];
    return mediaWanted(path) && (m.attempts > 0) && !m.healthySinceMs;
}

function onIceState(path, state) {
    Janus.log(path + " ICE state changed to " + state);
    const m = gMedia[path];
    if (m.iceTimer) {
        clearTimeout(m.iceTimer);
        m.iceTimer = null;
    }
    if (state === 'disconnected') {
        m.iceTimer = setTimeout(function() {
            m.iceTimer = null;
            const pc = mediaPc(path);
            if (pc && pc.iceConnectionState === 'disconnected') {
                recoverMedia(path, "ICE disconnected");
            }
        }, gIceDisconnectGraceMs);
    } else if (state === 'failed') {
        recoverMedia(path, "ICE failed");
    }
    updateConnIndicator();
}

// Escalating recovery for one media path: ICE restart first, then a fresh
// handle, then a fresh session
function recoverMedia(path, reason) {
    const m = gMedia[path];
    if (!mediaWanted(path)) {
        m.attempts = 0;
        return;
    }
    if (!gSessionReady) {
        // Session recovery puts the media back when it completes
        return;
    }
    const now = Date.now();
    if (now - m.lastAttemptMs < gRecoveryMinIntervalMs) {
        return;
    }
    m.lastAttemptMs = now;
    m.lastPacketsChangeMs = now;
    m.healthySinceMs = 0;
    m.attempts++;
    Janus.warn("Recovering " + path + " media, attempt " + m.attempts + " (" + reason + ")");
    if (m.attempts === 1) {
        iceRestart(path);
    } else if (m.attempts <= 3) {
        reattachMedia(path);
    } else {
        m.attempts = 0;
        sessionLost(path + " media could not be recovered");
    }
    updateConnIndicator();
}

function iceRestart(path) {
    const pc = mediaPc(path);
    if (!pc || pc.connectionState === 'closed') {
        reattachMedia(path);
        return;
    }
    const handle = mediaHandle(path);
    if (path === 'tx') {
        if (!gWebrtcUp) {
            reattachMedia(path);
            return;
        }
        handle.createOffer({
            iceRestart: true,
            customizeSdp: customizeStereoSdp,
            success: function(jsep) {
                handle.send({
                    message: {
                        request: "configure",
                        muted: gMuteIntention
                    },
                    jsep: jsep
                });
            },
            error: function(error) {
                Janus.warn("ICE restart offer failed", error);
                reattachMedia(path);
            }
        });
    } else {
        const id = (path === 'rx') ? gRxWatchId : gVideoWatchId;
        if (id === null) {
            reattachMedia(path);
            return;
        }
        // The streaming plugin answers with a new offer flagged as an ICE restart
        handle.send({
            message: {
                request: "watch",
                id: id,
                restart: true
            },
            error: function(error) {
                Janus.warn("ICE restart request failed", error);
                reattachMedia(path);
            }
        });
    }
}

// Replace the plugin handle, which gives a clean PeerConnection on both sides
function reattachMedia(path) {
    if (!gJanus || !gSessionReady) {
        return;
    }
    const gen = gSessionGen;
    const old = mediaHandle(path);
    Janus.log("Re-attaching " + path + " handle");
    if (path === 'rx') {
        gRemoteStream = null;
        attachStreaming('rx', gen, function() {
            if (gPlaying) {
                loadAudio();
            }
        });
    } else if (path === 'video') {
        gRemoteVidStream = null;
        gRemoteVidAudioStream = null;
        attachStreaming('video', gen, function() {
            if (gVidPlaying) {
                loadVideo();
            }
        });
    } else {
        gWebrtcUp = false;
        gRemoteRoomStream = null;
        attachAudiobridge(gen, function() {
            if (gSending) {
                loadSendRoom();
            }
        });
    }
    if (isRealHandle(old)) {
        old.detach({
            error: function(error) {
                Janus.warn("Error detaching old " + path + " handle", error);
            }
        });
    }
}

// The browser saw the network change: check the session and refresh the media
function networkChanged(reason) {
    Janus.log("Network change: " + reason);
    if (!gSessionReady) {
        retrySessionNow();
        return;
    }
    pollStatus();
    for (let path in gMedia) {
        if (mediaWanted(path)) {
            // Start again from a cheap ICE restart
            gMedia[path].attempts = 0;
            gMedia[path].lastAttemptMs = 0;
            recoverMedia(path, reason);
        }
    }
}

function checkConnectionHealth(reason) {
    if (!gSessionReady) {
        retrySessionNow();
        return;
    }
    pollStatus();
    for (let path in gMedia) {
        const pc = mediaPc(path);
        if (mediaWanted(path) && pc &&
            (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')) {
            recoverMedia(path, reason + ", ICE " + pc.iceConnectionState);
        }
    }
}

// Notice media that has stopped flowing even though nothing has reported an error
function mediaWatchdog() {
    ['rx', 'video'].forEach(function(path) {
        const m = gMedia[path];
        const pc = mediaPc(path);
        if (!gSessionReady || !mediaWanted(path) || !pc) {
            m.lastPackets = -1;
            return;
        }
        pc.getStats().then(function(stats) {
            let packets = 0;
            stats.forEach(function(report) {
                if (report.type === 'inbound-rtp') {
                    packets += report.packetsReceived || 0;
                }
            });
            const now = Date.now();
            if (packets !== m.lastPackets) {
                m.lastPackets = packets;
                m.lastPacketsChangeMs = now;
                noteHealthy(path, now);
            } else if ((now - m.lastPacketsChangeMs > gMediaStallMs) && mediaSourceLive(path)) {
                recoverMedia(path, "no media for " + Math.round((now - m.lastPacketsChangeMs) / 1000) + "s");
            }
        }).catch(function(err) {
            Janus.debug("getStats failed", err);
        });
    });
    // The translator's own packet counters keep rising even into a dead network,
    // so judge the uplink by its ICE state
    const pcTx = mediaPc('tx');
    if (gSending && gWebrtcUp && pcTx &&
        (pcTx.iceConnectionState === 'connected' || pcTx.iceConnectionState === 'completed')) {
        noteHealthy('tx', Date.now());
    }
}

function noteHealthy(path, now) {
    const m = gMedia[path];
    if (!m.healthySinceMs) {
        m.healthySinceMs = now;
        updateConnIndicator();
    } else if (m.attempts && (now - m.healthySinceMs > gHealthyResetMs)) {
        m.attempts = 0;
    }
}

function updateConnIndicator() {
    const stat = document.getElementById('stat');
    if (!stat) {
        return;
    }
    let text = "";
    if (gPlaying || gSending) {
        if (!navigator.onLine) {
            text = langText(gLang, 'offline');
        } else if (gSessionRecovery || mediaRecovering('rx') || mediaRecovering('video') || mediaRecovering('tx')) {
            text = langText(gLang, 'reconnecting');
        }
    }
    stat.innerText = text;
}

function customizeStereoSdp(jsep) {
    if (gStereo && jsep.sdp.indexOf("stereo=1") == -1) {
        // Make sure that our offer contains stereo too
        jsep.sdp = jsep.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
    }
}

// Optionally hold more audio in the browser's jitter buffer to ride out bursty WiFi
function applyJitterBufferTarget(handle) {
    const ms = parseInt(gSettings.jitterBufferMs);
    if (!ms || !handle || !handle.webrtcStuff || !handle.webrtcStuff.pc) {
        return;
    }
    handle.webrtcStuff.pc.getReceivers().forEach(function(receiver) {
        try {
            if ('jitterBufferTarget' in receiver) {
                receiver.jitterBufferTarget = ms;
            } else if ('playoutDelayHint' in receiver) {
                receiver.playoutDelayHint = ms / 1000;
            }
        } catch (err) {
            Janus.warn("Could not set jitter buffer target", err);
        }
    });
}

// Mute or unmute anything below a warning from Janus to prevent noise from polling
// "trace", "debug", "vdebug", "log", "warn", "error"
function janusLogMute(mute) {
    // Poll status debugging is enabled
    if (localStorage.enableDebugPollStatus.toLowerCase() === 'true') {
        return;
    }
    // Muting twice would save the no-op functions and lose the real ones
    if (mute === gLogMuted) {
        return;
    }
    gLogMuted = mute;
    // Disable or enable lower debug levels
    gDebugLevels.forEach(function(level) {
        if ((level !== 'error') && (level !== 'warn')) {
            if (mute) {
                gDebugBindStore[level] = Janus[level];
                Janus[level] = Janus.noop;
            } else {
                Janus[level] = gDebugBindStore[level];
            }
        }
    });
}

function attachAudiobridge(gen, onAttached) {
    const seq = ++gAttachSeq.tx;
    // Ignore callbacks from handles that have since been replaced
    const current = function() {
        return (gen === gSessionGen) && (seq === gAttachSeq.tx);
    };
    gJanus.attach({
        // Audiobridge is used for the translator to uplink the audio.
        // If another translator appears then they will hear each other.
        // This is useful for handing over from one translator to another without breaking the transmission
        plugin: "janus.plugin.audiobridge",
        opaqueId: gOpaqueIdSend,
        success: function(pluginHandle) {
            if (!current()) {
                pluginHandle.detach();
                return;
            }
            gSendMixerHandle = pluginHandle;
            Janus.log("Plugin attached! (" + gSendMixerHandle.getPlugin() + ", id=" + gSendMixerHandle.getId() + ")");
            onAttached();
        },
        error: function(error) {
            Janus.error("Error attaching plugin... " + error);
            if (current()) {
                sessionLost("audiobridge attach failed");
            }
        },
        consentDialog: function(on) {
            Janus.debug("Consent dialog should be " + (on ? "on" : "off") + " now");
            // Block TX panel interaction while waiting for response
            classSet('panelTx', 'blocker', on);
        },
        iceState: function(state) {
            if (current()) {
                onIceState('tx', state);
            }
        },
        mediaState: function(medium, on, mid) {
            Janus.log("Janus " + (on ? "started" : "stopped") + " receiving our " + medium + " (mid=" + mid + ")");
        },
        webrtcState: function(on) {
            Janus.log("Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
        },
        slowLink: function(uplink, lost, mid) {
            Janus.warn("Janus reports problems " + (uplink ? "sending" : "receiving") +
                " packets on mid " + mid + " (" + lost + " lost packets)");
        },
        onmessage: function(msg, jsep) {
            if (!current()) return;
            Janus.debug(" ::: Got a message :::", msg);
            const event = msg.audiobridge;
            Janus.debug("Event: " + event);
            switch (event) {
                case "joined":
                    gMyId = msg.id;
                    Janus.log("Successfully joined room " + msg.room + " with ID " + gMyId);
                    if (!gWebrtcUp) {
                        gWebrtcUp = true;
                        resetMediaState('tx');
                        // Publish our stream
                        const txChannel = channelIdLookup(msg.room);
                        gMusicTx = (txChannel >= 0) && gStatus[txChannel].music;
                        getMicTrack(function(track) {
                            gSendMixerHandle.createOffer({
                                tracks: [
                                    track,
                                    {
                                        type: 'video',
                                        capture: false,
                                        recv: false
                                    }
                                ],
                                customizeSdp: customizeStereoSdp,
                                success: function(jsep) {
                                    Janus.debug("Got SDP!", jsep);
                                    const publish = {
                                        request: "configure",
                                        muted: gMuteIntention
                                    };
                                    gSendMixerHandle.send({
                                        message: publish,
                                        jsep: jsep
                                    });
                                    // Start video if available
                                    const vidChannel = channelNumberLookup('Video Channel');
                                    if (!gVidPlaying && (vidChannel >= 0) && gStatus[vidChannel].videoValid) {
                                        gVidPlaying = true;
                                        loadVideo();
                                    }
                                },
                                error: function(error) {
                                    Janus.error("WebRTC error:", error);
                                    gWebrtcUp = false;
                                }
                            });
                        });
                    }
                    break;
                case "roomchanged":
                    gMyId = msg.id;
                    Janus.log("Moved to room " + msg.room + ", new ID: " + gMyId);
                    break;
                case "destroyed":
                    Janus.warn("The room has been destroyed!");
                    break;
                case "event":
                    if (msg.participants) {
                        const list = msg.participants;
                        Janus.debug("Got a list of participants:", list);
                    } else if (msg.error) {
                        if (msg.error_code == 489) {
                            authorisationFail();
                        }
                        Janus.error(msg.error);
                    }
                    if (msg.leaving) {
                        const leaving = msg.leaving;
                        Janus.log("Participant left: " + leaving);
                    }
                    break;
                case "left":
                    Janus.log("Left room", jsep);
                    gSendMixerHandle.hangup();
                    break;
                default:
                    Janus.warn("Unhandled event: " + event);
                    break;
            }
            if (jsep) {
                Janus.debug("Handling SDP as well...", jsep);
                gSendMixerHandle.handleRemoteJsep({
                    jsep: jsep
                });
            }
        },
        onlocaltrack: function(track, on) {

        },
        // We ignore mid in this application as there is only ever one audio track
        onremotetrack: function(track, mid, on) {
            if (!current()) return;
            Janus.debug("Remote track (mid=" + mid + ") " + (on ? "added" : "removed") + ":", track);
            if (track.kind !== "audio")
                return;
            if (!on) {
                // Often temporary, e.g. during an ICE restart. ICE state and
                // cleanup events decide whether recovery is needed.
                gRemoteRoomStream = null;
                return;
            }
            if (gRemoteRoomStream)
                return;
            gRemoteRoomStream = new MediaStream([track]);
            const audio = document.getElementById('audioRoom');
            Janus.attachMediaStream(audio, gRemoteRoomStream);
        },
        oncleanup: function() {
            if (!current()) return;
            Janus.debug("Clean up request");
            gWebrtcUp = false;
            gRemoteRoomStream = null;
            if (gSending) {
                // We did not ask to stop, so the connection was lost
                recoverMedia('tx', "translator connection closed");
            }
        }
    });
}

function attachStreaming(path, gen, onAttached) {
    const isVideo = (path === 'video');
    const seq = ++gAttachSeq[path];
    // Ignore callbacks from handles that have since been replaced
    const current = function() {
        return (gen === gSessionGen) && (seq === gAttachSeq[path]);
    };
    let handle = null;
    gJanus.attach({
        // Receive a translation channel stream either relayed from the corresponding translator room or received on Janus via RTP or RTSP
        plugin: "janus.plugin.streaming",
        opaqueId: gOpaqueId,
        iceState: function(state) {
            if (current()) {
                onIceState(path, state);
            }
        },
        webrtcState: function(on) {
            Janus.log("Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
        },
        slowLink: function(uplink, lost, mid) {
            Janus.warn("Janus reports problems " + (uplink ? "sending" : "receiving") +
                " packets on mid " + mid + " (" + lost + " lost packets)");
        },
        success: function(pluginHandle) {
            if (!current()) {
                pluginHandle.detach();
                return;
            }
            handle = pluginHandle;
            if (isVideo) {
                gVideoStreamingHandle = pluginHandle;
            } else {
                gStreamingHandle = pluginHandle;
            }
            Janus.log("Plugin attached! (" + pluginHandle.getPlugin() + ", id=" + pluginHandle.getId() + ")");
            onAttached();
        },
        error: function(error) {
            Janus.error("Error attaching plugin... " + error);
            if (current()) {
                sessionLost("streaming attach failed");
            }
        },
        onmessage: function(msg, jsep) {
            if (!current()) return;
            Janus.debug("Got message...");
            Janus.debug(msg);
            if (msg.error) {
                Janus.warn("Streaming error: " + msg.error);
            }
            if (jsep !== undefined && jsep !== null) {
                Janus.debug("Handling SDP as well...");
                Janus.debug(jsep);
                let stereo = (jsep.sdp.indexOf("stereo=1") !== -1);
                handle.createAnswer({
                    jsep: jsep,
                    customizeSdp: function(jsep) {
                        if (stereo && jsep.sdp.indexOf("stereo=1") == -1) {
                            // Make sure that our offer contains stereo too
                            jsep.sdp = jsep.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
                        }
                    },
                    // We want recvonly audio and, if negotiated, datachannels
                    tracks: [{
                            type: 'audio',
                            capture: false,
                            recv: true
                        },
                        {
                            type: 'video',
                            capture: false,
                            recv: true
                        },
                        {
                            type: 'data'
                        }
                    ],
                    success: function(jsep) {
                        Janus.debug("Got SDP!");
                        Janus.debug(jsep);
                        const body = {
                            "request": "start"
                        };
                        handle.send({
                            "message": body,
                            "jsep": jsep
                        });
                    },
                    error: function(error) {
                        Janus.error("WebRTC error:", error);
                    }
                });
            }
        },
        // We ignore mid in this application as there is only ever one audio track
        onremotetrack: function(track, mid, on) {
            if (!current()) return;
            Janus.debug("Remote track (mid=" + mid + ") " + (on ? "added" : "removed") + ":", track);
            const vidAudio = document.getElementById('videoStreamAudio');
            if (!on) {
                if (isVideo) {
                    gRemoteVidAudioStream = null;
                    gRemoteVidStream = null;
                } else {
                    gRemoteStream = null;
                    vidAudio.volume = 1;
                }
                updateDisplay();
                return;
            }
            if (track.muted) {
                return;
            }
            if (isVideo) {
                switch (track.kind) {
                    case 'audio':
                        if (!gRemoteVidAudioStream) {
                            vidAudio.volume = 0;
                            gRemoteVidAudioStream = new MediaStream([track]);
                            Janus.attachMediaStream(vidAudio, gRemoteVidAudioStream);
                            vidAudio.play().catch(function(err) {
                                Janus.warn("Video audio play failed", err);
                            });
                            vidAudio.volume = ((gPlaying) ? gDimVolume : 1);
                        }
                        break;
                    case 'video':
                        if (!gRemoteVidStream) {
                            const video = document.getElementById('videoStream');
                            gRemoteVidStream = new MediaStream([track]);
                            Janus.attachMediaStream(video, gRemoteVidStream);
                            video.play().catch(function(err) {
                                Janus.warn("Video play failed", err);
                            });
                            updateDisplay();
                        }
                        break;
                    default:
                        Janus.warn("Unexpected kind of remnote streaming track :", track.kind);
                }
            } else {
                if (track.kind === 'audio') {
                    if (!gRemoteStream) {
                        const audio = document.getElementById('audioStream');
                        audio.volume = 0;
                        gRemoteStream = new MediaStream([track]);
                        Janus.attachMediaStream(audio, gRemoteStream);
                        audio.play().catch(function(err) {
                            Janus.warn("Audio play failed", err);
                        });
                        audio.volume = 1;
                        vidAudio.volume = gDimVolume;
                        applyJitterBufferTarget(handle);
                    }
                } else {
                    Janus.warn("Unexpected kind of remnote streaming track :", track.kind);
                }
            }
        },
        oncleanup: function() {
            if (!current()) return;
            Janus.debug("Clean up request");
            if (isVideo) {
                gRemoteVidStream = null;
                gRemoteVidAudioStream = null;
            } else {
                gRemoteStream = null;
            }
            if (mediaWanted(path)) {
                // We did not ask to stop, so the connection was lost
                recoverMedia(path, "connection closed");
            }
        }
    });
}

function initaliseLocalStorageIfRequired(name) {
    if (!localStorage.channel) {
        localStorage.channel = name;
    }
    if (!localStorage.channelTx) {
        localStorage.channelTx = name;
    }
    if (localStorage.passwordsTx) {
        gPasswordsTx = JSON.parse(localStorage.passwordsTx);
    }
    if (!gPasswordsTx[localStorage.channelTx]) {
        gPasswordsTx[localStorage.channelTx] = gDefaultPassword;
        localStorage.passwordsTx = JSON.stringify(gPasswordsTx);
    }
}

// Poll channel status. This doubles as the check that signalling is still alive.
function pollStatus() {
    if (!gSessionReady || !isRealHandle(gStreamingHandle)) {
        return;
    }
    if (gPollInFlightSince) {
        if (Date.now() - gPollInFlightSince < gStatusPollTimeoutMs) {
            // Still waiting for the previous answer
            return;
        }
        Janus.warn("Status poll timed out");
        gPollSeq++;
        gPollInFlightSince = 0;
        janusLogMute(false);
        pollFailed();
        return;
    }
    const seq = ++gPollSeq;
    const gen = gSessionGen;
    const body = {
        "request": "list"
    };
    const failed = function(what, error) {
        if (seq !== gPollSeq) return;
        gPollInFlightSince = 0;
        janusLogMute(false);
        if (gen !== gSessionGen) return;
        Janus.error("Error polling server for " + what + "... " + error);
        pollFailed();
    };
    gPollInFlightSince = Date.now();
    janusLogMute(true);
    gStreamingHandle.send({
        "message": body,
        success: function(result) {
            if (seq !== gPollSeq || gen !== gSessionGen) return;
            if (!result || !result.list) {
                failed("RX streams", "empty response");
                return;
            }
            const list = result.list;
            Janus.debug("Got list of streams");
            gSendMixerHandle.send({
                "message": body,
                success: function(resultTx) {
                    if (seq !== gPollSeq) return;
                    gPollInFlightSince = 0;
                    janusLogMute(false);
                    if (gen !== gSessionGen) return;
                    gErrorCount = 0;
                    let listTx = false;
                    if (resultTx && resultTx.list) {
                        listTx = resultTx.list;
                        Janus.debug("Got list of rooms");
                    }
                    applyStatus(list, listTx);
                },
                error: function(error) {
                    failed("TX rooms", error);
                }
            });
        },
        error: function(error) {
            failed("RX streams", error);
        }
    });
}

function pollFailed() {
    gErrorCount++;
    if (gErrorCount >= gErrorMax) {
        gErrorCount = 0;
        sessionLost("status polls failing");
    }
}

function applyStatus(list, listTx) {
    let newStatus = [];
    for (let i = 0; i < list.length; i++) {
        let mp = list[i],
            validTx = false,
            freeTx = true,
            txParticipants = 0;
        if (listTx) {
            for (let j = 0; j < listTx.length; j++) {
                const mpTx = listTx[j];
                if (mpTx.room == mp.id) {
                    Janus.debug("Got match");
                    validTx = true;
                    txParticipants = mpTx.num_participants;
                    freeTx = (txParticipants <= ((gSendIntention) ? 1 : 0));
                    break;
                }
            }
        }
        const media = mp.media || [];
        const audioStream = media.find(({mid}) => mid === 'a');
        const videoStream = media.find(({mid}) => mid === 'v');
        let audioObj = (typeof(audioStream) === 'object')
        let videoObj = (typeof(videoStream) === 'object')
        const audioAge = (audioStream ? audioStream.age_ms : 0);
        const videoAge = (videoStream ? videoStream.age_ms : 0);
        Janus.debug("  >> [" + mp.id + "] " + mp.description + " (" + audioAge + ")");
        const musicChannel = (mp.description.length > 1 && (mp.description.substring(0, 1) === "*"));
        newStatus.push({
            'name': ((musicChannel) ? (mp.description.substring(1, )) : mp.description),
            'audioValid': (audioObj && mp.enabled && (audioAge < gMaxMediaAgeMs)),
            'music': musicChannel,
            'videoValid': (videoObj && mp.enabled && (videoAge < gMaxMediaAgeMs)),
            'id': mp.id,
            'validTx': validTx,
            'freeTx': freeTx,
            'participantsTx': txParticipants
        });
    }
    // Sort array by channel ID
    newStatus.sort((a, b) => (a.id > b.id) ? 1 : ((b.id > a.id) ? -1 : 0));
    // If any change then clone array
    if (JSON.stringify(gStatus) !== JSON.stringify(newStatus)) {
        gStatus = JSON.parse(JSON.stringify(newStatus));
        gStatusUpdate = true;
        if (gStatus.length > 0) {
            initaliseLocalStorageIfRequired(gStatus[0].name);
        }
        updateDisplay();
    }
    offerResume();
}

function timedPollStatus() {
    if (document.hidden) return true;
    pollStatus();
}

function channelNameLookup(channel) {
    let name = (parseInt(channel) + 1).toString();
    if ((channel < gStatus.length) && (gStatus[channel].hasOwnProperty("name"))) {
        name = gStatus[channel].name;
    }
    return name;
}

function channelNumberLookup(name) {
    if (!name) {
        return -1;
    }
    for (let channel in gStatus) {
        if (gStatus[channel].hasOwnProperty("name")) {
            if (name.toUpperCase() == gStatus[channel].name.toUpperCase()) {
                return parseInt(channel);
            }
        }
    }
    return -1;
}

function channelIdLookup(id) {
    for (let channel in gStatus) {
        if (gStatus[channel].hasOwnProperty("id")) {
            if (id == gStatus[channel].id) {
                return parseInt(channel);
            }
        }
    }
    return -1;
}

function channelLive(name) {
    const channel = channelNumberLookup(name);
    return (channel >= 0) && !!gStatus[channel].audioValid;
}

function channelTxValid(name) {
    const channel = channelNumberLookup(name);
    return (channel >= 0) && !!gStatus[channel].validTx;
}

function updateDisplay() {
    let listHtml = '';
    let listHtmlTx = '';
    let micListHtmlTx = '';
    for (let channel = 0; channel < gStatus.length; channel++) {
        let status = false,
            freeTx = true,
            validTx = false;
        let name = (parseInt(channel) + 1).toString();

        if (gStatus[channel].hasOwnProperty('audioValid')) {
            status = gStatus[channel].audioValid;
        }
        if (gStatus[channel].hasOwnProperty("name")) {
            name = gStatus[channel].name;
            // "Video channel" is a hidden reserved phrase for the video channel
            if (name.toLowerCase() === 'video channel') {
                continue;
            }
        }
        if (gStatus[channel].hasOwnProperty('freeTx')) {
            freeTx = gStatus[channel].freeTx;
        }
        if (gStatus[channel].hasOwnProperty('validTx')) {
            validTx = gStatus[channel].validTx;
        }

        // If name contains re`<regex>` then the regex between the backticks is used
        // to filter display by domain name for both receive and transmit
        let showForDomain = true;
        let dispName = name.replace(/re`[^`]+`/, "");
        if (name !== dispName) {
            let domainRegex = name.match(/re`[^`]+`/, "")[0].substring(3).slice(0,-1);
            showForDomain = (window.location.hostname.match(new RegExp(domainRegex)) !== null);
        }
        if (showForDomain) {
            if (status) {
                listHtml += "<a href=\"#\"" +
                    " class=\"chNameNormal\"" +
                    " onclick=\"onclickChannel(" + channel + ");\"" +
                    " ontouchend=\"ontouchendChannel(" + channel + ");\"" +
                    ">" + dispName + "</a>\n";
            } else {
                if (!gSettings.hideOffAir) {
                    listHtml += "<a href=\"#\" class=\"disabled chNameNormal\">" + dispName + "</a>\n";
                }
            }

            if (validTx) {
                listHtmlTx += "<a href=\"#\"" +
                    " class=\"" + ((freeTx) ? "chNameNormal" : "chNameBusy") + "\"" +
                    " onclick=\"onclickChannelTx(" + channel + ");\"" +
                    " ontouchend=\"ontouchendChannelTx(" + channel + ");\"" +
                    ">" + dispName + "</a>\n";
            } else {
                listHtmlTx += "<a href=\"#\" class=\"disabled\">" + dispName + "</a>\n";
            }
        }

        if (name == localStorage.channel) {
            const chNameId = document.getElementById('chName');
            const startStopButtonId = document.getElementById('startStopButton');
            chNameId.innerHTML = dispName.replace(/[" "]/g, "<br />");
            classSet('chName', 'chNameDead', !status);
            if (gSettings.videoScreenKeeperRx) {
                classSet('playVid', 'greyVid', !status);
            } else {
                classSet('playImg', 'greyVid', !status);
            }
            if (status) {
                startStopButtonId.innerText = LANG[gLang][(gPlayIntention) ? 'stop' : 'start'];
                startStopButtonId.disabled = false;
            } else {
                startStopButtonId.innerText = LANG[gLang][(gPlayIntention) ? 'stop' : 'start'];
                startStopButtonId.disabled = !gPlayIntention;
            }

        }
        if (name == localStorage.channelTx) {
            const chNameId = document.getElementById('chNameTx');
            const startMuteButtonId = document.getElementById('startMuteButtonTx');
            const startMuteButtonTextEng = (gMuteIntention) ? "unmute" : ((gSendIntention) ? 'mute' : 'broadcast');
            const startMuteButtonText = LANG[gLang][startMuteButtonTextEng];
            chNameId.innerHTML = dispName.replace(/[" "]/g, "<br />");
            classSet('chNameTx', 'chNameDead', !validTx);
            classSet('sendingVidOn', 'greyVid', !validTx);
            classSet('sendingVidMute', 'greyVid', !validTx);
            classSet('sendingImgOn', 'greyVid', !validTx);
            classSet('sendingImgMute', 'greyVid', !validTx);
            if (validTx) {
                classSet('chNameTx', 'chNameBusy', !freeTx);
                startMuteButtonId.innerText = startMuteButtonText;
                startMuteButtonId.disabled = false;
            } else {
                classOut('chNameTx', 'chNameBusy');
                startMuteButtonId.innerText = LANG[gLang][(gSendIntention) ? 'mute' : 'broadcast'];
                startMuteButtonId.disabled = !gSendIntention;
            }
        }
    }
    gMicList.forEach(function(device) {
        if (device.deviceId && (device.kind === 'audioinput')) {
            let micActive = (localStorage.micDeviceId === device.deviceId);
            micListHtmlTx += "<a href=\"#\"" +
                " class=\"" + (micActive ? "micActive" : "micName") + "\"" +
                " onclick=\"onclickMicTx('" + device.deviceId + "');\"" +
                " ontouchend=\"ontouchendMicTx('" + device.deviceId + "');\"" +
                ">" + device.label + "</a>\n";
        }
    });
    document.getElementById('chSelectList').innerHTML = listHtml;
    document.getElementById('chSelectListTx').innerHTML = listHtmlTx;
    document.getElementById('micSelectListTx').innerHTML = micListHtmlTx;
    document.getElementById('chSelectBtn').innerText = LANG[gLang].select;
    document.getElementById('chSelectBtnTx').innerText = LANG[gLangTx].select;
    document.getElementById('chSelectBtnTx').disabled = gSending;
    document.getElementById('stopButtonTx').innerText = LANG[gLangTx].stop;
    document.getElementById('passFailBox').innerHTML = LANG[gLangTx].unauthorised;
    document.getElementById('passOKButton').innerText = LANG[gLangTx].ok;
    document.getElementById('passCancelButton').innerText = LANG[gLangTx].cancel;
    updateConnIndicator();

    classSet('vidDiv', 'hideItem', !gSettings.videoScreenKeeperRx);
    classSet('imgDiv', 'hideItem', gSettings.videoScreenKeeperRx);

    classSet('vidDiv', 'lampStopped', !gPlaying);
    classSet('vidDiv', 'lampStarted', gPlaying);
    classSet('imgDiv', 'lampStopped', !gPlaying);
    classSet('imgDiv', 'lampStarted', gPlaying);


    classSet('vidTxDiv', 'hideItem', !gSettings.videoScreenKeeperTx);
    classSet('imgTxDiv', 'hideItem', gSettings.videoScreenKeeperTx);

    classSet('vidOnTx', 'hideItem', gMuteIntention);
    classSet('vidOnTx', 'lampStopped', !gSending);
    classSet('vidOnTx', 'lampStartedTx', gSending);
    classSet('vidMuteTx', 'hideItem', !gMuteIntention);
    classSet('vidMuteTx', 'lampStopped', !gSending);
    classSet('vidMuteTx', 'lampStartedTx', gSending);
    classSet('imgOnTx', 'hideItem', gMuteIntention);
    classSet('imgOnTx', 'lampStopped', !gSending);
    classSet('imgOnTx', 'lampStartedTx', gSending);
    classSet('imgMuteTx', 'hideItem', !gMuteIntention);
    classSet('imgMuteTx', 'lampStopped', !gSending);
    classSet('imgMuteTx', 'lampStartedTx', gSending);

    document.getElementById('stopButtonTx').style.visibility = (gSendIntention) ? "visible" : "hidden";
    classSet('micDiv', 'hideItem', gHideMic);
    classSet('micImg', 'iconDisabled', gSendIntention);
    classSet('keyImg', 'iconDisabled', gSendIntention);

    classSet('videoStream', 'hideItem', (gRemoteVidStream === null))
}

//Drop down menu related
function chSelect() {
    gUserHasScrolled = false;
    document.getElementById('chSelectList').classList.toggle("show");
}

function chSelectTx() {
    gUserHasScrolled = false;
    document.getElementById('chSelectListTx').classList.toggle("show");
}

function micSelectTx() {
    // Update mic list before showing
    Janus.listDevices(function(micDevices) {
        gMicList = JSON.parse(JSON.stringify(micDevices));
        let hasDefault = false;
        gMicList.forEach(function(device) {
            if (device.deviceId && (device.deviceId.toLowerCase() === 'default') && (device.kind === 'audioinput')) {
                hasDefault = true;
            }
        });
        // Add a "Default" device if none returned. No deviceId is requested if a default device selected.
        if (!hasDefault) {
            gMicList.unshift({
                deviceId: 'default',
                groupId: '',
                kind: 'audioinput',
                label: 'Default'
            });
        }
        gUserHasScrolled = false;
        updateDisplay();
        document.getElementById('micSelectListTx').classList.toggle("show");
    }, {
        audio: true,
        video: false
    });
}

function vanishDropdown(className) {
    const dropdowns = document.getElementsByClassName(className);
    for (let i = 0; i < dropdowns.length; i++) {
        const openDropdown = dropdowns[i];
        if (openDropdown.classList.contains('show')) {
            openDropdown.classList.remove('show');
        }
    }
}

// Close the dropdown menu if the user clicks outside of it
function positionTests(event) {
    if (!event.target.matches('.dropbtn') &&
        !event.target.matches('.dropdown-content.show') &&
        !event.target.matches('a.chNameNormal')) {
        vanishDropdown("dropdown-content");
    }
    if (!event.target.matches('.dropbtnTx') &&
        !event.target.matches('a.chNameNormal')) {
        vanishDropdown("dropdown-contentTx");
    }
    if (!event.target.matches('.micSelDiv') &&
        !event.target.matches('a.micNameNormal')) {
        vanishDropdown("dropdown-contentMicTx");
    }
    //Hide QR code if showing
    if (!event.target.matches('.qrBtn')) {
        classOut('qrBox', 'qrShow');
    }
}
window.ontouchend = function(event) {
    if (mobileAndTabletcheck()) {
        positionTests(event);
    }
}
window.onclick = function(event) {
    if (!mobileAndTabletcheck()) {
        positionTests(event);
    }
}


function loadAudio() {
    const channel = channelNumberLookup(localStorage.channel);
    if (channel < 0 || !isRealHandle(gStreamingHandle) || !gSessionReady) {
        // Session recovery or the next status update will start it
        return;
    }
    gRxWatchId = gStatus[channel].id;
    resetMediaState('rx');
    gStreamingHandle.send({
        "message": {
            "request": "watch",
            "id": gRxWatchId
        }
    });
}

function loadSendRoom() {
    const channel = channelNumberLookup(localStorage.channelTx);
    if (channel < 0 || !isRealHandle(gSendMixerHandle) || !gSessionReady) {
        return;
    }
    resetMediaState('tx');
    gSendMixerHandle.send({
        message: {
            request: "join",
            room: gStatus[channel].id,
            codec: "opus",
            display: "translator",
            pin: gPasswordsTx[localStorage.channelTx]
        }
    });
}

function loadVideo() {
    const channel = channelNumberLookup('Video Channel');
    if (channel < 0 || !isRealHandle(gVideoStreamingHandle) || !gSessionReady) {
        return;
    }
    gVideoWatchId = gStatus[channel].id;
    resetMediaState('video');
    gVideoStreamingHandle.send({
        "message": {
            "request": "watch",
            "id": gVideoWatchId
        }
    });
}

function startPlay() {
    if (!gPlaying) {
        gPlaying = true;
        loadAudio();
        const vidPlayer = document.getElementById('playVid');
        if (vidPlayer && gSettings.videoScreenKeeperRx) {
            vidPlayer.play();
        }
        const silentPlayer = document.getElementById('silence');
        if (silentPlayer && silentPlayer.paused) {
            silentPlayer.play();
        }
        // Activate wake lock and silent oscillator
        requestWakeLock();
        createSilentOscillator();
        updateDisplay();
    }
}

function startSend() {
    if (!gSending) {
        gSending = true;
        loadSendRoom();
        const vidPlayerTx = document.getElementById('sendingVidOn');
        if (vidPlayerTx && gSettings.videoScreenKeeperTx) {
            vidPlayerTx.play();
        }
        const silentPlayer = document.getElementById('silenceTx');
        if (silentPlayer && silentPlayer.paused) {
            silentPlayer.play();
        }
        // Activate wake lock and silent oscillator
        requestWakeLock();
        createSilentOscillator();
        updateDisplay();
    }
}

function muteSend() {
    const body = {
        "request": "configure",
        "muted": true
    };
    const vidPlayerMtTx = document.getElementById('sendingVidMute');
    const vidPlayerTx = document.getElementById('sendingVidOn');
    if (vidPlayerTx) {
        vidPlayerTx.pause();
    }
    if (vidPlayerMtTx && gSettings.videoScreenKeeperTx) {
        vidPlayerMtTx.play();
    }
    gSendMixerHandle.send({
        "message": body
    });
    updateDisplay();
}

function stopPlay() {
    // Clear the flag first so the cleanup that follows is not mistaken for a dropout
    const wasPlaying = gPlaying;
    gPlaying = false;
    if (wasPlaying && isRealHandle(gStreamingHandle)) {
        gStreamingHandle.send({
            "message": {
                "request": "stop"
            }
        });
        gStreamingHandle.hangup();
    }
    resetMediaState('rx');
    const vidPlayer = document.getElementById('playVid');
    if (vidPlayer) {
        vidPlayer.pause();
    }
    const silentPlayer = document.getElementById('silence');
    if (silentPlayer && !silentPlayer.paused) {
        silentPlayer.pause();
    }
    // Release wake lock and stop oscillator if nothing else is playing
    if (!gSending) {
        releaseWakeLock();
        stopSilentOscillator();
    }
    updateDisplay();
}

function stopSend() {
    // Clear the flags first so the cleanup that follows is not mistaken for a dropout
    const wasSending = gSending;
    const wasVidPlaying = gVidPlaying;
    gSending = false;
    gVidPlaying = false;
    if (wasVidPlaying && isRealHandle(gVideoStreamingHandle)) {
        gVideoStreamingHandle.send({
            "message": {
                "request": "stop"
            }
        });
        gVideoStreamingHandle.hangup();
    }
    resetMediaState('video');
    resetMediaState('tx');
    if (wasSending) {
        if (gWebrtcUp && isRealHandle(gSendMixerHandle)) {
            gSendMixerHandle.send({
                "message": {
                    "request": "leave"
                }
            });
        }
        const vidPlayerTx = document.getElementById('sendingVidOn');
        if (vidPlayerTx) {
            vidPlayerTx.pause();
        }
        const silentPlayer = document.getElementById('silenceTx');
        if (silentPlayer && !silentPlayer.paused) {
            silentPlayer.pause();
        }
    }
    // Release wake lock and stop oscillator if nothing else is playing
    if (!gPlaying) {
        releaseWakeLock();
        stopSilentOscillator();
    }
    updateDisplay();
}

function unMuteSend() {
    const body = {
        "request": "configure",
        "muted": false
    };
    const vidPlayerMtTx = document.getElementById('sendingVidMute');
    const vidPlayerTx = document.getElementById('sendingVidOn');
    if (vidPlayerTx && gSettings.videoScreenKeeperTx) {
        vidPlayerTx.play();
    }
    if (vidPlayerMtTx) {
        vidPlayerMtTx.pause();
    }
    gSendMixerHandle.send({
        "message": body
    });
    updateDisplay();
}


function onclickStart() {
    if (!mobileAndTabletcheck()) {
        startPlay();
    }
}

function onclickStartTx() {
    if (!mobileAndTabletcheck()) {
        startSend();
    }
}

function ontouchendStart() {
    if (mobileAndTabletcheck() && !document.getElementById('startStopButton').disabled) {
        startPlay();
    }
}

function ontouchendStartTx() {
    if (mobileAndTabletcheck() && !document.getElementById('startStopButtonTx').disabled) {
        startSend();
    }
}

function channelEnact(channel) {
    vanishDropdown("dropdown-content");
    localStorage.channel = channelNameLookup(channel);
    updateDisplay();
    if (gPlaying) {
        Janus.log("Stop RX on channel change");
        stopPlay();
        // Poll until stop is complete
        let waitForStop = setInterval(function() {
            if (!gPlaying) {
                startPlay();
                clearInterval(waitForStop);
            }
        }, 500);
    }
}

function channelEnactTx(channel) {
    vanishDropdown("dropdown-contentTx");
    localStorage.channelTx = channelNameLookup(channel);
    if (!gPasswordsTx[localStorage.channelTx]) {
        gPasswordsTx[localStorage.channelTx] = gDefaultPassword;
        localStorage.passwordsTx = JSON.stringify(gPasswordsTx);
    }
    updateDisplay();
}

function micEnactTx(deviceId) {
    vanishDropdown("dropdown-contentMicTx");
    localStorage.micDeviceId = deviceId;
    if (gWebrtcUp) {
        updateLiveMic();
    }
}

function onclickChannel(channel) {
    if (!mobileAndTabletcheck()) {
        channelEnact(channel);
    }
}

function onclickChannelTx(channel) {
    if (!mobileAndTabletcheck()) {
        channelEnactTx(channel);
    }
}

function onclickMicTx(deviceId) {
    if (!mobileAndTabletcheck()) {
        micEnactTx(deviceId);
    }
}

function ontouchendChannel(channel) {
    if (mobileAndTabletcheck() && !gUserHasScrolled) {
        channelEnact(channel);
    }
    gUserHasScrolled = false;
}

function ontouchendChannelTx(channel) {
    if (mobileAndTabletcheck() && !gUserHasScrolled) {
        channelEnactTx(channel);
    }
    gUserHasScrolled = false;
}

function ontouchendMicTx(deviceId) {
    if (mobileAndTabletcheck()) {
        micEnactTx(deviceId);
    }
}

// The main start/stop button handler
function clickPlayerEnact() {
    if (gPlayIntention) {
        gPlayIntention = false;
        Janus.debug("Stop on clickPlayerEnact");
        stopPlay();
    } else {
        gPlayIntention = true;
        Janus.debug("Start on clickPlayerEnact");
        startPlay();
    }
}

function startStopPlayerClick() {
    if (!mobileAndTabletcheck()) {
        clickPlayerEnact();
    }
}

function startStopPlayerTouchend() {
    if (mobileAndTabletcheck() && !document.getElementById('startStopButton').disabled) {
        clickPlayerEnact();
    }
}

// The main Broadcast/Mute button handler
function clickSenderStartMuteEnact() {
    if (gSendIntention) {
        if (gMuteIntention) {
            gMuteIntention = false;
            Janus.debug("Unmute on clickSenderStartMuteEnact");
            unMuteSend();
        } else {
            gMuteIntention = true;
            Janus.debug("Mute on clickSenderStartMuteEnact");
            muteSend();
        }
    } else {
        gSendIntention = true;
        Janus.debug("Broadcast on clickSenderStartMuteEnact");
        startSend();
    }
}
// The main start/stop button handler
function clickSenderStopEnact() {
    if (gSendIntention) {
        gSendIntention = false;
        gMuteIntention = false;
        Janus.debug("Stop on clickSenderStopEnact");
        stopSend();
        gSending = false;
        gVidPlaying = false;
        // Need to re-update display to reflect not sending flag
        updateDisplay();
    }
}

function authorisationFail() {
    clickSenderStopEnact();
    // (Re)Trigger warning message fade in/out
    const passBox = document.getElementById('passFailBox');
    classOut('passFailBox', 'passFailBoxShow');
    void passBox.offsetWidth;
    classIn('passFailBox', 'passFailBoxShow');
}

function startMuteSenderClick() {
    if (!mobileAndTabletcheck()) {
        clickSenderStartMuteEnact();
    }
}

function startMuteSenderTouchend() {
    if (mobileAndTabletcheck()) {
        clickSenderStartMuteEnact();
    }
}

function stopSenderClick() {
    if (!mobileAndTabletcheck()) {
        clickSenderStopEnact();
    }
}

function stopSenderTouchend() {
    if (mobileAndTabletcheck()) {
        clickSenderStopEnact();
    }
}

function toggleTxPanel() {
    // Only allow TX menu to be hidden if not broadcasting
    if (!gSendIntention || document.getElementById('panelTx').classList.contains('hideItem')) {
        document.getElementById('panelTx').classList.toggle('hideItem');
        orientation();
    }
}

function sizeRx(full) {
    classSet('tableRx', 'panelHeightHalf', !full);
    classSet('tableRx', 'panelHeightFull', full);
    classSet('chSelectList', 'menuHeightHalf', !full);
    classSet('chSelectList', 'menuHeightFull', full);
}

function sizeTx(full) {
    classSet('tableTx', 'panelHeightHalf', !full);
    classSet('tableTx', 'panelHeightFull', full);
    classSet('chSelectListTx', 'menuHeightHalf', !full);
    classSet('chSelectListTx', 'menuHeightFull', full);
    classSet('micSelectListTx', 'menuHeightHalf', !full);
    classSet('micSelectListTx', 'menuHeightFull', full);
}

// What happens when orientiation changes depends on whether TX panel is visible
function orientation() {
    const txHidden = document.getElementById('panelTx').classList.contains('hideItem');
    if (gPortrate) {
        if (txHidden) {
            // Full size
            sizeRx(true);
        } else {
            sizeRx(false);
            sizeTx(false);
        }
    } else {
        sizeRx(true);
        sizeTx(true);
    }
}

function keyDialog() {
    const passDiv = document.getElementById('passBox');
    const passText = LANG[gLang]['set password'] + " : " + document.getElementById('chNameTx').innerHTML;
    // Only allow password dialog to appear if not broadcasting
    if (!gSendIntention || passDiv.classList.contains('passShow')) {
        passwordKeyUp();
        classIn('passBox', 'passShow');
        document.getElementById('passBoxText').innerHTML = passText;
        classIn('panelTx', 'blocker');
    }
}

function passClose() {
    classOut('passBox', 'passShow');
    classOut('panelTx', 'blocker');
}

function passCancel() {
    passClose();
}

function passOK() {
    const passInput = document.getElementById('password');
    gPasswordsTx[localStorage.channelTx] = passInput.value;
    localStorage.passwordsTx = JSON.stringify(gPasswordsTx);
    passInput.value = "";
    passClose();
}

function passwordKeyUp(event) {
    const noLength = (document.getElementById('password').value.length < 1);
    document.getElementById('passOKButton').disabled = noLength;
    if (event && event.keyCode && event.keyCode == 13) {
        if (noLength) {
            passCancel();
        } else {
            passOK();
        }
    }
}

function passShow() {
    const pwBox = document.getElementById('password');
    if (pwBox.type === 'password') {
        pwBox.type = 'text';
    } else {
        pwBox.type = 'password';
    }
}

function passOKClick() {
    if (!mobileAndTabletcheck()) {
        passOK();
    }
}

function passOKTouchend() {
    if (mobileAndTabletcheck()) {
        passOK();
    }
}

function passCancelClick() {
    if (!mobileAndTabletcheck()) {
        passCancel();
    }
}

function passCancelTouchend() {
    if (mobileAndTabletcheck()) {
        passCancel();
    }
}
