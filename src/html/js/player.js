const gBrowserLang = window.navigator.language.substring(0,2);
const gDefaultPassword = "secret";
const gOpaqueId = "streaming-" + Janus.randomString(12);
const gOpaqueIdSend = "audiobridge-" + Janus.randomString(12);
const gMaxAudioAgeMs = 2000;
const gLang = (LANG.hasOwnProperty(gBrowserLang))?gBrowserLang:'en';
const gLangTx = gLang;
const gErrorMax = 3;

let gSettings = {};
let gServer = "janus";

let gStatus = [];
let gStatusUpdate = false;
let gPortrate = (window.innerHeight > window.innerWidth);

let gPlayIntention = false;
let gSendIntention = false;
let gMuteIntention = false;
let gPlaying = false;
let gSending = false;
let gPasswordsTx = {};

let gJanus = null;
let gJanusSend= null;
let gStreamingHandle = null;
let gSendMixerHandle = null;
let gMyId = null;
let gStereo = false;
let gWebrtcUp = false;
let gRemoteStream = null;
let gRemoteRoomStream = null;
let gErrorCount = 0;

// Available debug outputs: 'trace', 'debug', 'vdebug', 'log', 'warn', 'error'
// Modifiy in local storage to set desired debug level in browser
let gDebugLevels = ['warn', 'error'];
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

window.onload = function () {
    runWithSettings(function () {
        janusInit();
        updateDisplay();
        pollStatus();
        setInterval(timedPollStatus, 5000);    
        // Listen for resize changes
        window.addEventListener("resize", function() {
            // Get screen size (inner/outerWidth, inner/outerHeight)
            const portrate = (window.innerHeight > window.innerWidth);
            if (portrate != gPortrate) {
                gPortrate = portrate;
                orientation();
            }
        }, false);
        orientation ();
        
        // Play silence on a loop when playing WebRTC audio to keep phone
        // alive when screen goes off.
        // Start/stop WebRTC when this player starts/stops.
        const silentPlayer = document.getElementById('silence');
        if (silentPlayer) {
            silentPlayer.addEventListener('play', function(){
                startPlay();
            });
            silentPlayer.addEventListener('pause', function(){
                stopPlay();
            })
        }
        const silentPlayerTx = document.getElementById('silenceTx');
        if (silentPlayerTx) {
            silentPlayerTx.addEventListener('play', function(){
                startSend();
            });
            silentPlayerTx.addEventListener('pause', function(){
                stopSend();
            })
        }
    });
};

function jumpBack () {
    if (gSettings.timeoutUrl !== false) {
        window.location.href = gSettings.timeoutUrl;
    } else {
        window.location.reload();
    }    
}

// If we have lost the server then jump to holding page if it is set
function reloadOrJumpBack () {
    fetch("index.html", {cache: "no-store"}).then(function(response) {
        return response.text();
    }).then(function(html) {
        if (html.includes("Translation Web Client")) {
            // Reload page if it exists
            window.location.reload();
        } else {
            jumpBack();
        }
    }).catch(function (err) {
        jumpBack();
    });
}

function janusInit () {
    Janus.init({
        debug: gDebugLevels,
        callback: function() {
            if(!Janus.isWebrtcSupported()) {
                Janus.error("No WebRTC support");
                return;
            }
            if (!gHideMic) {
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
                                        if(!gWebrtcUp) {
                                            gWebrtcUp = true;
                                            // Publish our stream
                                            gSendMixerHandle.createOffer(
                                            {
                                                track: [
                                                    { type: 'audio', capture: true, recv: true },
                                                    { type: 'video', capture: false, recv: false },
                                                    { type: 'data' }
                                                ],
                                                customizeSdp: function(jsep) {
                                                    if(gStereo && jsep.sdp.indexOf("gStereo=1") == -1) {
                                                        // Make sure that our offer contains gStereo too
                                                        jsep.sdp = jsep.sdp.replace("useinbandfec=1", "useinbandfec=1;gStereo=1");
                                                    }
                                                },
                                                success: function(jsep) {
                                                    Janus.debug("Got SDP!", jsep);
                                                    const publish = { request: "configure", muted: false };
                                                    gSendMixerHandle.send({ message: publish, jsep: jsep });
                                                    },
                                                error: function(error) {
                                                    Janus.error("WebRTC error:", error);
                                                }
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
                                        if(msg.participants) {
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
                                        Janus.debug("Left room", jsep);
                                        break;
                                    default:
                                        Janus.warn("Unhandled event: " + event);
                                        break;
                                }
                                if(jsep) {
                                    Janus.debug("Handling SDP as well...", jsep);
                                    gSendMixerHandle.handleRemoteJsep({ jsep: jsep });
                                }
                            },
                            // We ignore mid in this application as there is only ever one audio track
                            onremotetrack: function(track,mid,on) {
                                Janus.debug("Remote track (mid=" + mid + ") " + (on ? "added" : "removed") + ":", track);
                                if(gRemoteRoomStream || track.kind !== "audio")
                                    return;
                                if(!on) {
                                    gRemoteRoomStream = null;
                                    return;
                                }
                                gRemoteRoomStream = new MediaStream();
                                gRemoteRoomStream.addTrack(track.clone());
                                const audio = document.getElementById('audioRoom');
                                Janus.attachMediaStream(audio, gRemoteRoomStream);
                            },
                            oncleanup: function() {
                                Janus.debug("Clean up request");
                                gRemoteRoomStream = null;
                            }
                        });
                    },
                    error: function(error) {
                        Janus.error(error);
                    },
                    destroyed: function() {
                        reloadOrJumpBack();
                    }
                });
            } else {
                // Generate fake empty response
                gSendMixerHandle = {"send":function (fakeParams) {
                    fakeParams.success({"list":[]});
                }}
            }
            gJanus = new Janus({
                server: gServer,
                iceServers: gSettings.iceServers,
                success: function() {
                    gJanus.attach({
                        // Receive a translation channel stream either relayed from the corresponding translator room or received on Janus via RTP
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
                            gStreamingHandle = pluginHandle;
                            Janus.log("Plugin attached! (" + gStreamingHandle.getPlugin() + ", id=" + gStreamingHandle.getId() + ")");
                            pollStatus();
                        },
                        error: function(error) {
                            Janus.error("Error attaching plugin... " + error);
                        },
                        onmessage: function(msg, jsep) {
                            Janus.debug("Got message...");
                            Janus.debug(msg);
                            if(jsep !== undefined && jsep !== null) {
                                Janus.debug("Handling SDP as well...");
                                Janus.debug(jsep);
                                var stereo = (jsep.sdp.indexOf("stereo=1") !== -1);
                                gStreamingHandle.createAnswer({
                                    jsep: jsep,
                                    customizeSdp: function(jsep) {
                                        if(stereo && jsep.sdp.indexOf("stereo=1") == -1) {
                                            // Make sure that our offer contains stereo too
                                            jsep.sdp = jsep.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
                                        }
                                    },
                                    // We want recvonly audio and, if negotiated, datachannels
                                    track: [
                                                { type: 'audio', capture: false, recv: true },
                                                { type: 'video', capture: false, recv: false },
                                                { type: 'data' }
                                            ],
                                    success: function(jsep) {
                                        Janus.debug("Got SDP!");
                                        Janus.debug(jsep);
                                        const body = { "request": "start" };
                                        gStreamingHandle.send({"message": body, "jsep": jsep});
                                    },
                                    error: function(error) {
                                        Janus.error("WebRTC error:", error);
                                    }
                                });
                            }
                        },
                        // We ignore mid in this application as there is only ever one audio track
                        onremotetrack: function(track,mid,on) {
                            Janus.debug("Remote track (mid=" + mid + ") " + (on ? "added" : "removed") + ":", track);
                            if(gRemoteStream || track.kind !== "audio")
                                return;
                            // We only have one track in this application
                            if(!on) {
                                 gRemoteStream = null;
                                 return;
                            }
                            const audio = document.getElementById('audioStream');
                            audio.volume = 0;
                            gRemoteStream = new MediaStream([track]);
                            gRemoteStream.addTrack(track.clone());
                            Janus.attachMediaStream(audio, gRemoteStream);
                            audio.play();
                            audio.volume = 1;
                        },
                        oncleanup: function() {
                            Janus.debug("Clean up request");
                            gRemoteStream = null;
                            gPlaying = false;
                        }
                    });
                }
            });
        },
        error: function(error) {
            Janus.error(error);
        },
        destroyed: function() {
            reloadOrJumpBack();
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

//Poll status every two seconds
function pollStatus () {
    if (gStreamingHandle !== null) {
        const body = { "request": "list" };
        gStreamingHandle.send({"message": body,
            success: function(result) {
                if(result === null || result === undefined) {
                        alert("Got no response to our query for available RX streams");
                } else {
                    const list = result.list;
                    Janus.debug("Got list of streams");
                    gSendMixerHandle.send({"message": body, 
                        success: function(result) {
                            let listTx = false;
                            if(result === null || result === undefined) {
                                alert("Got no response to our query for available TX rooms");
                            } else {
                                listTx = result.list;
                                Janus.debug("Got list of rooms");
                            }
                            let newStatus = [];
                            for(let i=0; i < list.length; i++) {
                                let mp = list[i], validTx = false, freeTx = true, txParticipants = 0;
                                if (listTx) {
                                    for (let j = 0; j < listTx.length; j++) {
                                        const mpTx = listTx[j];
                                        if (mpTx.room == mp.id) {
                                            Janus.debug("Got match");
                                            validTx = true;
                                            txParticipants = mpTx.num_participants;
                                            freeTx = (txParticipants <= ((gSendIntention)?1:0));
                                            break;
                                        }
                                    }
                                }
                                // Asuming first stream [0] is audio since that is all we are sending
                                const audioAge = (mp.media[0])?mp.media[0].age_ms:0;
                                Janus.debug("  >> [" + mp.id + "] " + mp.description + " (" + audioAge + ")");
                                newStatus.push({'name':mp.description,
                                            'valid':((audioAge < gMaxAudioAgeMs) && (mp.enabled == true)),
                                            'id':mp.id,
                                            'validTx':validTx,
                                            'freeTx':freeTx,
                                            'participantsTx':txParticipants
                                });
                            }
                            // Sort array by channel ID
                            newStatus.sort((a,b) => (a.id > b.id) ? 1 : ((b.id > a.id) ? -1 : 0));
                            // If any change then clone array
                            if (JSON.stringify(gStatus) !== JSON.stringify(newStatus)) {
                                gStatus = JSON.parse(JSON.stringify(newStatus));
                                gStatusUpdate = true;
                                    if (gStatus.length > 0) {
                                        initaliseLocalStorageIfRequired(gStatus[0].name);
                                    }
                                updateDisplay();
                            }
                        },
                        error: function (error) {
                            Janus.error("Error polling server for TX streams... " + error);
                            gErrorCount++;
                            if (gErrorCount > gErrorMax) {
                                reloadOrJumpBack();
                            }
                        }
                    });
                }
            },
            error: function (error) {
                Janus.error("Error polling server for RX streams... " + error);
                gErrorCount++;
                if (gErrorCount > gErrorMax) {
                    reloadOrJumpBack();
                }
            }
        });
    }
}

function timedPollStatus () {
    if (document.hidden) return true;
    pollStatus();
}

function channelNameLookup (channel) {
    let name = (parseInt(channel) + 1).toString();
    if ((channel < gStatus.length) && (gStatus[channel].hasOwnProperty("name"))) {
        name = gStatus[channel].name;
    }
    return name;
}

function channelNumberLookup (name) {
    for (let channel in gStatus) {
        if (gStatus[channel].hasOwnProperty("name")) {
            if (name.toUpperCase() == gStatus[channel].name.toUpperCase()) {
                return channel;
            }
        }
    }
    return -1;
}

function updateDisplay() {
    let listHtml = '';
    let listHtmlTx = '';
    for (let channel = 0; channel < gStatus.length; channel++) {
        let status = false, freeTx = true, validTx = false;
        let name = (parseInt(channel) + 1).toString();

        if (gStatus[channel].hasOwnProperty('valid')) {
            status = gStatus[channel].valid;
        }
        if (gStatus[channel].hasOwnProperty("name")) {
            name = gStatus[channel].name;
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
            listHtml += "<a href=\"#\" class=\"disabled chNameNormal\">" + name + "</a>\n";
        }

        if (validTx) {
            listHtmlTx +="<a href=\"#\"" +
            " class=\"" + ((freeTx)?"chNameNormal":"chNameBusy") + "\"" +
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
                startStopButtonId.innerText = LANG[gLang][(gPlayIntention)?'stop':'start'];
               startStopButtonId.disabled = false;
            } else {
                startStopButtonId.innerText = LANG[gLang][(gPlayIntention)?'stop':'start'];
                startStopButtonId.disabled = !gPlayIntention;
            }

        }
        if (name == localStorage.channelTx) {
            const chNameId = document.getElementById('chNameTx');
            const startMuteButtonId = document.getElementById('startMuteButtonTx');
            const startMuteButtonTextEng = (gMuteIntention)?"unmute":((gSendIntention)?'mute':'broadcast');
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
                startMuteButtonId.innerText = LANG[gLang][(gSendIntention)?'mute':'broadcast'];
                startMuteButtonId.disabled = !gSendIntention;
            }
        }
    }
    document.getElementById('chSelectList').innerHTML = listHtml;
    document.getElementById('chSelectListTx').innerHTML = listHtmlTx;
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
    
    document.getElementById('stopButtonTx').style.visibility = (gSendIntention)?"visible":"hidden";
    classSet('micDiv', 'hideItem', gHideMic);
    classSet('micImg', 'iconDisabled', gSendIntention);
    classSet('keyImg', 'iconDisabled', gSendIntention);
}

//Drop down menu related
function chSelect() {
    document.getElementById('chSelectList').classList.toggle("show");
}
function chSelectTx() {
    document.getElementById('chSelectListTx').classList.toggle("show");
}
// Close the dropdown menu if the user clicks outside of it
function positionTests (event) {
    if (!event.target.matches('.dropbtn')) {
        const dropdowns = document.getElementsByClassName("dropdown-content");
        for (let i = 0; i < dropdowns.length; i++) {
            const openDropdown = dropdowns[i];
            if (openDropdown.classList.contains('show')) {
            openDropdown.classList.remove('show');
            }
        }
    }
    if (!event.target.matches('.dropbtnTx')) {
        const dropdownsTx = document.getElementsByClassName("dropdown-contentTx");
        for (let i = 0; i < dropdownsTx.length; i++) {
            const openDropdown = dropdownsTx[i];
            if (openDropdown.classList.contains('show')) {
            openDropdown.classList.remove('show');
            }
        }
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


function loadAudio () {
    const body = { "request": "watch", "id": gStatus[channelNumberLookup (localStorage.channel)].id };
    if (gStreamingHandle) {
        gStreamingHandle.send({"message": body});
    }
}

function loadSendRoom () {
    const register = { request: "join", codec: "opus", display: "translator", pin: gPasswordsTx[localStorage.channelTx] };
    register.room = gStatus[channelNumberLookup (localStorage.channelTx)].id;
    if (gSendMixerHandle) {
        gSendMixerHandle.send({ message: register });
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
    const body = { "request": "configure", "muted": true };
    const vidPlayerMtTx = document.getElementById('sendingVidMute');
    const vidPlayerTx = document.getElementById('sendingVidOn');
    if (vidPlayerTx) {
        vidPlayerTx.pause();
    }
    if (vidPlayerMtTx && gSettings.videoScreenKeeperTx) {
        vidPlayerMtTx.play();
    }
    gSendMixerHandle.send({"message": body});
    updateDisplay();
}

function stopPlay() {
    const body = { "request": "stop" };
    gStreamingHandle.send({"message": body});
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
    if (gSending) {
        const body = { "request": "leave" };
        gSendMixerHandle.send({"message": body});
        const vidPlayerTx = document.getElementById('sendingVidOn');
        if (vidPlayerTx) {
            vidPlayerTx.pause();
        }
        const silentPlayer = document.getElementById('silenceTx');
        if (silentPlayer && !silentPlayer.paused) {
            silentPlayer.pause();
        }
        updateDisplay();
    }
}
function unMuteSend() {
    const body =  { "request": "configure", "muted": false };
    const vidPlayerMtTx = document.getElementById('sendingVidMute');
    const vidPlayerTx = document.getElementById('sendingVidOn');
    if (vidPlayerTx && gSettings.videoScreenKeeperTx) {
        vidPlayerTx.play();
    }
    if (vidPlayerMtTx) {
        vidPlayerMtTx.pause();
    }
    gSendMixerHandle.send({"message": body});
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

function channelEnact (channel) {
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

function channelEnactTx (channel) {
    localStorage.channelTx = channelNameLookup(channel);
    if (!gPasswordsTx[localStorage.channelTx]) {
        gPasswordsTx[localStorage.channelTx] = gDefaultPassword;
        localStorage.passwordsTx = JSON.stringify(gPasswordsTx);
    }
    updateDisplay();   
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

function ontouchendChannel(channel) {
    if (mobileAndTabletcheck()) {
        channelEnact(channel);
    }
}
function ontouchendChannelTx(channel) {
    if (mobileAndTabletcheck()) {
        channelEnactTx(channel);
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
    }
}

function authorisationFail () {
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
        orientation ();
    }
}
function sizeRx (full) {
    classSet('tableRx', 'panelHeightHalf', !full);
    classSet('tableRx', 'panelHeightFull', full);
}
function sizeTx (full) {
    classSet('tableTx', 'panelHeightHalf', !full);
    classSet('tableTx', 'panelHeightFull', full);
}

// What happens when orientiation changes depends on whether TX panel is visible
function orientation () {
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

function passOK () {
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

function passShow () {
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
