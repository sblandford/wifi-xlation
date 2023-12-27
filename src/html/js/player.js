const gBrowserLang = window.navigator.language.substring(0, 2);
const gDefaultPassword = "secret";
const gOpaqueId = "streaming-" + Janus.randomString(12);
const gOpaqueIdSend = "audiobridge-" + Janus.randomString(12);
const gMaxMediaAgeMs = 2000;
const gLang = (LANG.hasOwnProperty(gBrowserLang)) ? gBrowserLang : 'en';
const gLangTx = gLang;
const gErrorMax = 3;
const gMenuScrollTimoutMs = 150;
const gStatusPollTime = 5000;
const gDimVolume = 0.05;

let gSettings = {};
let gServer = "janus";

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

let gJanusReceive = null;
let gJanusVideoReceive = null;
let gJanusSend = null;
let gStreamingHandle = null;
let gVideoStreamingHandle = null;
let gSendMixerHandle = null;
let gMyId = null;
let gStereo = false;
let gWebrtcUp = false;
let gMusicTx = false;
let gRemoteStream = null;
let gRemoteVidStream = null;
let gRemoteVidAudioStream = null;
let gRemoteRoomStream = null;
let gErrorCount = 0;
let gUserHasScrolled = false;
let gHasScrolledTimer = null;


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
        janusInit();
        updateDisplay();
        pollStatus();
        setInterval(timedPollStatus, gStatusPollTime);
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

function jumpBack() {
    if (gSettings.timeoutUrl !== false) {
        window.location.href = gSettings.timeoutUrl;
    } else {
        window.location.reload();
    }
}

// If we have lost the server then jump to holding page if it is set
function reloadOrJumpBack() {
    fetch("index.html", {
        cache: "no-store"
    }).then(function(response) {
        return response.text();
    }).then(function(html) {
        if (html.includes("Translation Web Client")) {
            // Reload page if it exists
            window.location.reload();
        } else {
            jumpBack();
        }
    }).catch(function(err) {
        jumpBack();
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

function janusInit() {
    Janus.init({
        debug: gDebugLevels,
        callback: function() {
            if (!Janus.isWebrtcSupported()) {
                Janus.error("No WebRTC support");
                return;
            }
            // Generate fake empty response
            gSendMixerHandle = {
                "send": function(fakeParams) {
                    fakeParams.success({
                        "list": []
                    });
                }
            };
            if (!gHideMic) {
                sendInit();
                videoReceiveInit();
            }
            receiveInit();
        },
        error: function(error) {
            Janus.error(error);
        },
        destroyed: function() {
            reloadOrJumpBack();
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

function sendInit() {
    if (gJanusSend) {
        return;
    }
    gJanusSend = new Janus({
        server: gServer,
        iceServers: gSettings.iceServers,
        success: function() {
            gJanusSend.attach({
                // Audiobridge is used for the translator to uplink the audio.
                // If another translator appears then they will hear each other.
                // This is useful for handing over from one translator to another without breaking the transmission
                plugin: "janus.plugin.audiobridge",
                gOpaqueId: gOpaqueIdSend,
                success: function(pluginHandle) {
                    gSendMixerHandle = pluginHandle;
                    Janus.log("Plugin attached! (" + gSendMixerHandle.getPlugin() + ", id=" + gSendMixerHandle.getId() + ")");
                },
                error: function(error) {
                    Janus.error("Error attaching plugin... " + error);
                },
                consentDialog: function(on) {
                    Janus.debug("Consent dialog should be " + (on ? "on" : "off") + " now");
                    // Block TX panel interaction while waiting for response
                    classSet('panelTx', 'blocker', on);
                },
                iceState: function(state) {
                    Janus.log("ICE state changed to " + state);
                },
                mediaState: function(medium, on, mid) {
                    Janus.log("Janus " + (on ? "started" : "stopped") + " receiving our " + medium + " (mid=" + mid + ")");
                },
                webrtcState: function(on) {
                    Janus.log("Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
                },
                onmessage: function(msg, jsep) {
                    Janus.debug(" ::: Got a message :::", msg);
                    const event = msg.audiobridge;
                    Janus.debug("Event: " + event);
                    switch (event) {
                        case "joined":
                            gMyId = msg.id;
                            Janus.log("Successfully joined room " + msg.room + " with ID " + gMyId);
                            if (!gWebrtcUp) {
                                gWebrtcUp = true;
                                // Publish our stream
                                gMusicTx = gStatus[channelIdLookup(msg.room)].music;
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
                                        customizeSdp: function(jsep) {
                                            if (gStereo && jsep.sdp.indexOf("gStereo=1") == -1) {
                                                // Make sure that our offer contains gStereo too
                                                jsep.sdp = jsep.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
                                            }
                                        },
                                        success: function(jsep) {
                                            gJespTx = jsep;
                                            Janus.debug("Got SDP!", jsep);
                                            const publish = {
                                                request: "configure",
                                                muted: false
                                            };
                                            gSendMixerHandle.send({
                                                message: publish,
                                                jsep: jsep
                                            });
                                            // Start video if available
                                            if (!gVidPlaying && gStatus[channelNumberLookup('Video Channel')].videoValid) {
                                                gVidPlaying = true;
                                                loadVideo();
                                            }
                                        },
                                        error: function(error) {
                                            Janus.error("WebRTC error:", error);
                                        }
                                    });
                                });
                            }
                            break;
                        case "roomchanged":
                            gMyId = msg.id;
                            Janus.log("Moved to room " + msg.room + ", new ID: " + myid);
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
                    Janus.debug("Remote track (mid=" + mid + ") " + (on ? "added" : "removed") + ":", track);
                    if (track.kind !== "audio")
                        return;
                    if (!on) {
                        gRemoteRoomStream = null;
                        gJanusSend.destroy();
                        return;
                    }
                    if (gRemoteRoomStream)
                        return;
                    gRemoteRoomStream = new MediaStream();
                    gRemoteRoomStream.addTrack(track.clone());
                    const audio = document.getElementById('audioRoom');
                    Janus.attachMediaStream(audio, gRemoteRoomStream);
                },
                oncleanup: function() {
                    Janus.debug("Clean up request");
                }
            });
        },
        error: function(error) {
            Janus.error(error);
        },
        destroyed: function() {
            Janus.log("Send destroyed, re-initialising");
            gWebrtcUp = false;
            gSendMixerHandle = null;
            gJanusSend = null;
            sendInit();
        }
    });
}

function receiveOjb(isVideo) {
    return new Janus({
        server: gServer,
        iceServers: gSettings.iceServers,
        success: function() {
            ((isVideo) ? gJanusVideoReceive : gJanusReceive).attach({
                // Receive a translation channel stream either relayed from the corresponding translator room or received on Janus via RTP or RTSP
                plugin: "janus.plugin.streaming",
                gOpaqueId: gOpaqueId,
                iceState: function(state) {
                    Janus.log("ICE state changed to " + state);
                },
                webrtcState: function(on) {
                    Janus.log("Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
                },
                slowLink: function(uplink, lost, mid) {
                    Janus.warn("Janus reports problems " + (uplink ? "sending" : "receiving") +
                        " packets on mid " + mid + " (" + lost + " lost packets)");
                },
                success: function(pluginHandle) {
                    if (isVideo) {
                        gVideoStreamingHandle = pluginHandle;
                    } else {
                        gStreamingHandle = pluginHandle;
                    }
                    Janus.log("Plugin attached! (" + pluginHandle.getPlugin() + ", id=" + pluginHandle.getId() + ")");
                    pollStatus();
                },
                error: function(error) {
                    Janus.error("Error attaching plugin... " + error);
                },
                onmessage: function(msg, jsep) {
                    Janus.debug("Got message...");
                    Janus.debug(msg);
                    if (jsep !== undefined && jsep !== null) {
                        Janus.debug("Handling SDP as well...");
                        Janus.debug(jsep);
                        let stereo = (jsep.sdp.indexOf("stereo=1") !== -1);
                        let handle = (isVideo) ? gVideoStreamingHandle : gStreamingHandle;
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
                    Janus.debug("Remote track (mid=" + mid + ") " + (on ? "added" : "removed") + ":", track);
                    //if(gRemoteStream || track.kind !== "audio" || track.kind !== "video")
                    //    return;
                    // We only have one track in this application
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
                                    gRemoteVidAudioStream.addTrack(track.clone());
                                    Janus.attachMediaStream(vidAudio, gRemoteVidAudioStream);
                                    vidAudio.play();
                                    vidAudio.volume = ((gPlaying) ? gDimVolume : 1);
                                }
                                break;
                            case 'video':
                                if (!gRemoteVidStream) {
                                    const video = document.getElementById('videoStream');
                                    gRemoteVidStream = new MediaStream([track]);
                                    gRemoteVidStream.addTrack(track.clone());
                                    Janus.attachMediaStream(video, gRemoteVidStream);
                                    video.play();
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
                                gRemoteStream.addTrack(track.clone());
                                Janus.attachMediaStream(audio, gRemoteStream);
                                audio.play();
                                audio.volume = 1;
                                vidAudio.volume = gDimVolume;
                            }
                        } else {
                            Janus.warn("Unexpected kind of remnote streaming track :", track.kind);
                        }
                    }
                },
                oncleanup: function() {
                    Janus.debug("Clean up request");
                    if (isVideo) {
                        gRemoteVidStream = null;
                        gVidPlaying = false
                    } else {
                        gRemoteStream = null;
                        gPlaying = false;
                    }
                }
            });
        }
    });
}

function receiveInit() {
    if (gJanusReceive) {
        return;
    }
    gJanusReceive = receiveOjb(false);
}

function videoReceiveInit() {
    if (gJanusVideoReceive) {
        return;
    }
    gJanusVideoReceive = receiveOjb(true);
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

//Poll status every two seconds
function pollStatus() {
    if (gStreamingHandle !== null) {
        const body = {
            "request": "list"
        };
        janusLogMute(true);
        gStreamingHandle.send({
            "message": body,
            success: function(result) {
                if (result === null || result === undefined) {
                    alert("Got no response to our query for available RX streams");
                } else {
                    const list = result.list;
                    Janus.debug("Got list of streams");
                    if (gSendMixerHandle) {
                        gSendMixerHandle.send({
                            "message": body,
                            success: function(result) {
                                let listTx = false;
                                if (result === null || result === undefined) {
                                    alert("Got no response to our query for available TX rooms");
                                } else {
                                    listTx = result.list;
                                    Janus.debug("Got list of rooms");
                                }
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
                                    const audioStream = mp.media.find(({mid}) => mid === 'a');
                                    const videoStream = mp.media.find(({mid}) => mid === 'v');
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
                                janusLogMute(false);
                            },
                            error: function(error) {
                                Janus.error("Error polling server for TX streams... " + error);
                                gErrorCount++;
                                if (gErrorCount > gErrorMax) {
                                    reloadOrJumpBack();
                                }
                                janusLogMute(false);
                            }
                        });
                    } else {
                        Janus.log("Send mixer handle null at present time");
                    }
                }
            },
            error: function(error) {
                janusLogMute(false);
                Janus.error("Error polling server for RX streams... " + error);
                gErrorCount++;
                if (gErrorCount > gErrorMax) {
                    reloadOrJumpBack();
                }
            }
        });
    }
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
    for (let channel in gStatus) {
        if (gStatus[channel].hasOwnProperty("name")) {
            if (name.toUpperCase() == gStatus[channel].name.toUpperCase()) {
                return channel;
            }
        }
    }
    return -1;
}

function channelIdLookup(id) {
    for (let channel in gStatus) {
        if (gStatus[channel].hasOwnProperty("id")) {
            if (id == gStatus[channel].id) {
                return channel;
            }
        }
    }
    return -1;
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

        if (status) {
            listHtml += "<a href=\"#\"" +
                " class=\"chNameNormal\"" +
                " onclick=\"onclickChannel(" + channel + ");\"" +
                " ontouchend=\"ontouchendChannel(" + channel + ");\"" +
                ">" + name + "</a>\n";
        } else {
            if (!gSettings.hideOffAir) {
                listHtml += "<a href=\"#\" class=\"disabled chNameNormal\">" + name + "</a>\n";
            }
        }

        if (validTx) {
            listHtmlTx += "<a href=\"#\"" +
                " class=\"" + ((freeTx) ? "chNameNormal" : "chNameBusy") + "\"" +
                " onclick=\"onclickChannelTx(" + channel + ");\"" +
                " ontouchend=\"ontouchendChannelTx(" + channel + ");\"" +
                ">" + name + "</a>\n";
        } else {
            listHtmlTx += "<a href=\"#\" class=\"disabled\">" + name + "</a>\n";
        }

        if (name == localStorage.channel) {
            const chNameId = document.getElementById('chName');
            const startStopButtonId = document.getElementById('startStopButton');
            chNameId.innerHTML = name.replaceAll(" ", "<br />");
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
            chNameId.innerHTML = name.replaceAll(" ", "<br />");
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
    document.getElementById('stat').innerText = "";

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
    const body = {
        "request": "watch",
        "id": gStatus[channelNumberLookup(localStorage.channel)].id
    };
    if (gStreamingHandle) {
        gStreamingHandle.send({
            "message": body
        });
    }
}

function loadSendRoom() {
    const register = {
        request: "join",
        codec: "opus",
        display: "translator",
        pin: gPasswordsTx[localStorage.channelTx]
    };
    register.room = gStatus[channelNumberLookup(localStorage.channelTx)].id;
    if (gSendMixerHandle) {
        gSendMixerHandle.send({
            message: register
        });
    }
}

function loadVideo() {
    const body = {
        "request": "watch",
        "id": gStatus[channelNumberLookup('Video Channel')].id
    };
    if (gVideoStreamingHandle) {
        gVideoStreamingHandle.send({
            "message": body
        });
    }
}

function startPlay() {
    if (!gPlaying) {
        loadAudio();
        const vidPlayer = document.getElementById('playVid');
        if (vidPlayer && gSettings.videoScreenKeeperRx) {
            vidPlayer.play();
        }
        const silentPlayer = document.getElementById('silence');
        if (silentPlayer && silentPlayer.paused) {
            silentPlayer.play();
        }
        gPlaying = true;
        updateDisplay();
    }
}

function startSend() {
    if (!gSending) {
        loadSendRoom();
        const vidPlayerTx = document.getElementById('sendingVidOn');
        if (vidPlayerTx && gSettings.videoScreenKeeperTx) {
            vidPlayerTx.play();
        }
        const silentPlayer = document.getElementById('silenceTx');
        if (silentPlayer && silentPlayer.paused) {
            silentPlayer.play();
        }
        gSending = true;
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
    const body = {
        "request": "stop"
    };
    gStreamingHandle.send({
        "message": body
    });
    gStreamingHandle.hangup();
    const vidPlayer = document.getElementById('playVid');
    if (vidPlayer) {
        vidPlayer.pause();
    }
    const silentPlayer = document.getElementById('silence');
    if (silentPlayer && !silentPlayer.paused) {
        silentPlayer.pause();
    }
    updateDisplay();
}

function stopSend() {
    if (gVidPlaying) {
        const body = {
            "request": "stop"
        };
        gVideoStreamingHandle.send({
            "message": body
        });
        gVideoStreamingHandle.hangup();
    }
    if (gSending) {
        if (gWebrtcUp) {
            const body = {
                "request": "leave"
            };
            gSendMixerHandle.send({
                "message": body
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
    if (gSendIntention && gSending) {
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
