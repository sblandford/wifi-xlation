// Preset translator switch if requested
let url = new URL(document.location);
let params = new URLSearchParams(url.search);
if (params.has('show')) {
    gHideMic = (params.get('xlator') !== 'true' );
    localStorage.setItem('hideMic', gHideMic.toString());
}

function xlatorShowSwitch() {
    let xSwitch = document.getElementById('xlatorSwitch');
    gHideMic = !xSwitch.checked;
    localStorage.setItem('hideMic', gHideMic.toString());
}
function xlatorShowClick() {
    if (!mobileAndTabletcheck()) {
        xlatorShowSwitch();
    }
}

function xlatorShowTouchend() {
    if (mobileAndTabletcheck()) {
        xlatorShowSwitch();
    }
}

window.onload = function () {
    let xSwitch = document.getElementById('xlatorSwitch');
    xSwitch.checked = !gHideMic;
}
