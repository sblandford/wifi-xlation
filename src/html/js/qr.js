let settings = {}; 
let gPath = "";
let gBaseURL = window.location.protocol + "//" + window.location.hostname, port = window.location.port;
if (port !== "" && port !== "80" && port !== "443") {
    gBaseURL += ":" + port;
}

function pathUpdate () {
    gPath = '/xlator.html?show=' + (!gHideMic).toString();
}

function dispUpdate () {
    let qrDiv = document.getElementById("qrcode");
    qrDiv.innerHTML = "";
    new QRCode(qrDiv, gBaseURL + gPath);
    document.getElementById("urlSpan").innerHTML = gBaseURL + gPath;
}

function pathMonitor () {
    let prevHideMic = gHideMic;
    setInterval(function () {
        loadStoredHideMic();
        if (prevHideMic !== gHideMic) {
            pathUpdate();
            dispUpdate();
            prevHideMic = gHideMic;
        }
    }, 1000);
}

window.onload = function () {
    runWithSettings(function() {
        // Show translator switch page if requested
        let url = new URL(document.location);
        let params = new URLSearchParams(url.search);
        if (params.has('xlator')) {
            pathUpdate();
            pathMonitor();
        } else {
            if ((typeof gSettings.qrCodeUrl !== 'undefined') && (gSettings.qrCodeUrl.length > 2)) {
                gBaseURL = gSettings.qrCodeUrl;
            }
        }
        dispUpdate();
    });
}
