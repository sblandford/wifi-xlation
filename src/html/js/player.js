// Available debug outputs: 'trace', 'debug', 'vdebug', 'log', 'warn', 'error'
const gDebugLevels = ['warn', 'error'];
const gBrowserLang = window.navigator.language.substring(0,2);
const gDefaultPassword = "secret";
const gOpaqueId = "streaming-" + Janus.randomString(12);
const gOpaqueIdSend = "audiobridge-" + Janus.randomString(12);
const gMaxAudioAgeMs = 2000;
const gLang = (LANG.hasOwnProperty(gBrowserLang))?gBrowserLang:'en';
const gLangTx = gLang;

let gServer = "janus";
if ( ws !== false ) {
    gServer = ws + "://" + window.location.hostname + ":" + ((ws === "wss")?"8989":"8188");
}

let gStatus = [];
let gStatusUpdate = false;
let gPortrate = (window.innerHeight > window.innerWidth);
let gMobileAndTabletState = null;

let gPlayIntention = false;
let gSendIntention = false;
let gMuteIntention = false;
let gPlaying = false;
let gSending = false;
let gPasswordsTx = {};

let gIceServers = [{urls: "stun:stun.l.google.com:19302"}];
//let gIceServers = null;
let gJanus = null;
let gJanusSend= null;
let gStreamingHandle = null;
let gSendMixerHandle = null;
let gMyId = null;
let gStereo = false;
let gWebrtcUp = false;
let gRemoteStream = null;
let gRemoteRoomStream = null;

window.onload = function () {

    Janus.init({
        debug: gDebugLevels,
        callback: function() {
            if(!Janus.isWebrtcSupported()) {
                Janus.error("No WebRTC support");
                return;
            }
            gJanusSend = new Janus({
                server: gServer,
                iceServers: gIceServers,
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
                                            media: { video: false, audioSend: true },    // This is an audio only room
                                            /* track will replace media in a future release
                                            track: [
                                                { type: 'audio', capture: true, recv: true },
                                                { type: 'video', capture: false, recv: false },
                                                { type: 'data' }
                                            ], */
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
                    window.location.reload();
                }
            });
            gJanus = new Janus({
                server: gServer,
                iceServers: gIceServers,
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
                                    // For iOS we have to request audio capture for playback to work
                                    media: { video: false, audioSend: false },    // This is an audio receive-only stream, except for IOS bug workaround
                                    /* track will replace media in a future release
                                    track: [
                                                { type: 'audio', capture: false, recv: true },
                                                { type: 'video', capture: false, recv: false },
                                                { type: 'data' }
                                            ], */
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
                        }
                    });
                }
            });
        },
        error: function(error) {
            Janus.error(error);
        },
        destroyed: function() {
            window.location.reload();
        }
    });
    updateDisplay();
    pollStatus();
    setInterval(pollStatus, 5000);
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
};

function classIn (id, className) {
    const classList = document.getElementById(id).classList;
    if (!classList.contains(className)) {
        classList.add(className);
    }
}

function classOut (id, className) {
    const classList = document.getElementById(id).classList;
    if (classList.contains(className)) {
        classList.remove(className);
    }
}

function classSet (id, className, state) {
    if (state) {
        classIn (id, className);
    } else {
        classOut (id, className);
    }
}


function mobileAndTabletcheck () {

    if (gMobileAndTabletState == null) {
        gMobileAndTabletState = false;

        (function(a){if(/(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino|android|ipad|playbook|silk/i.test(a)||/1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw-(n|u)|c55\/|capi|ccwa|cdm-|cell|chtm|cldc|cmd-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc-s|devi|dica|dmob|do(c|p)o|ds(12|-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(-|_)|g1 u|g560|gene|gf-5|g-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd-(m|p|t)|hei-|hi(pt|ta)|hp( i|ip)|hs-c|ht(c(-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i-(20|go|ma)|i230|iac( |-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|-[a-w])|libw|lynx|m1-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|-([1-8]|c))|phil|pire|pl(ay|uc)|pn-2|po(ck|rt|se)|prox|psio|pt-g|qa-a|qc(07|12|21|32|60|-[2-7]|i-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h-|oo|p-)|sdk\/|se(c(-|0|1)|47|mc|nd|ri)|sgh-|shar|sie(-|m)|sk-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h-|v-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl-|tdg-|tel(i|m)|tim-|t-mo|to(pl|sh)|ts(70|m-|m3|m5)|tx-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas-|your|zeto|zte-/i.test(a.substr(0,4))) gMobileAndTabletState = true;})(navigator.userAgent||navigator.vendor||window.opera);
    }
    return gMobileAndTabletState;
}

function showQr() {
    let boxWidth, boxHeight;
    const boxDiv = document.getElementById("qrBox");
    const boxObj = document.getElementById("qrObj");

    //Needs two iterations to settle on correct size
    for (let i=0; i < 2; i++) {
        boxWidth = boxDiv.offsetWidth;
        boxHeight = boxDiv.offsetHeight;

        boxObj.width = document.documentElement.clientWidth;
        boxObj.height = document.documentElement.clientHeight * 0.6;

        if (boxWidth < 400) {
            const scale = boxWidth / 400;
            boxObj.style.transform = "scale(" + scale + ")";
        } else {
            boxObj.style.transform = "scale(1)";
        }
    }
    boxDiv.classList.toggle("qrShow");
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
        gStreamingHandle.send({"message": body, success: function(result) {
            if(result === null || result === undefined) {
                    alert("Got no response to our query for available RX streams");
            } else {
                const list = result.list;
                Janus.debug("Got list of streams");
                gSendMixerHandle.send({"message": body, success: function(result) {
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
                }});
            }
        }});
    }
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
            chNameId.innerHTML = name;
            classSet('chName', 'chNameDead', !status);
            classSet('playing', 'greyVid', !status);
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
            chNameId.innerHTML = name;
            classSet('chNameTx', 'chNameDead', !validTx);
            classSet('sendingOn', 'greyVid', !validTx);
            classSet('sendingMute', 'greyVid', !validTx);
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
    const vidDivId = document.getElementById('vid');
    if (vidDivId) {
        classSet('vid', 'vidStopped', !gPlaying);
        classSet('vid', 'vidStarted', gPlaying);
    }
    const vidOnDivIdTx = document.getElementById('vidOnTx');
    if (vidOnDivIdTx) {
        classSet('vidOnTx', 'hideItem', gMuteIntention);
        classSet('vidOnTx', 'vidStopped', !gSending);
        classSet('vidOnTx', 'vidStartedTx', gSending);
    }
    const vidMuteDivIdTx = document.getElementById('vidMuteTx');
    if (vidMuteDivIdTx) {
        classSet('vidMuteTx', 'hideItem', !gMuteIntention);
        classSet('vidMuteTx', 'vidStopped', !gSending);
        classSet('vidMuteTx', 'vidStartedTx', gSending);
    }
    document.getElementById('stopButtonTx').style.visibility = (gSendIntention)?"visible":"hidden";
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
window.onclick = function(event) {
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
};


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
    loadAudio();
    const vidPlayer = document.getElementById('playing');
    if (vidPlayer) {
        vidPlayer.play();
    }
    gPlaying = true;
    updateDisplay();
}
function startSend() {
    loadSendRoom();
    const vidPlayerTx = document.getElementById('playingTx');
    if (vidPlayerTx) {
        vidPlayerTx.play();
    }
    gSending = true;
    updateDisplay();
}
function muteSend() {
    const body = { "request": "configure", "muted": true };
    gSendMixerHandle.send({"message": body});
    updateDisplay();
}

function stopPlay() {
    const body = { "request": "stop" };
    gStreamingHandle.send({"message": body});
    gStreamingHandle.hangup();
    const vidPlayer = document.getElementById('playing');
    if (vidPlayer) {
        vidPlayer.pause();
    }
    gPlaying = false;
    updateDisplay();
}
function stopSend() {
    const body = { "request": "leave" };
    gSendMixerHandle.send({"message": body});
    const vidPlayerTx = document.getElementById('playingTx');
    if (vidPlayerTx) {
        vidPlayerTx.pause();
    }
    gSending = false;
    updateDisplay();
}
function unMuteSend() {
    const body =  { "request": "configure", "muted": false };
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
function onclickChannel(channel) {
    if (!mobileAndTabletcheck()) {
        localStorage.channel = channelNameLookup(channel);
        updateDisplay();
        if (gPlaying) {
            Janus.log("Stop RX on channel change");
            stopPlay();
            startPlay();
        }
    }
}
function onclickChannelTx(channel) {
    if (!mobileAndTabletcheck()) {
        localStorage.channelTx = channelNameLookup(channel);
        if (!gPasswordsTx[localStorage.channelTx]) {
            gPasswordsTx[localStorage.channelTx] = gDefaultPassword;
            localStorage.passwordsTx = JSON.stringify(gPasswordsTx);
        }
        updateDisplay();
        if (gSending) {
            Janus.log("Stop TX on channel change");
            stopSend();
            startSend();
        }
    }
}

function ontouchendChannel(channel) {
    if (mobileAndTabletcheck()) {
        localStorage.channel = channelNameLookup(channel);
        updateDisplay();
        if (gPlaying) {
            startPlay();
        }
    }
}
function ontouchendChannelTx(channel) {
    if (mobileAndTabletcheck()) {
        localStorage.channelTx = channelNameLookup(channel);
        if (!gPasswordsTx[localStorage.channelTx]) {
            gPasswordsTx[localStorage.channelTx] = gDefaultPassword;
            localStorage.passwordsTx = JSON.stringify(gPasswordsTx);
        }
        updateDisplay();
        if (gSending) {
            startSend();
        }
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
