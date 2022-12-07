let gHideMic = gHideMicDefault;
if (localStorage.getItem('hideMic')) {
    gHideMic = (gHideMic === 'true');
} else {
    localStorage.setItem('hideMic', gHideMic.toString());
}

function xlatorShowSwitch() {
    let xSwitch = document.getElementById('xlatorSwitch');
    gHideMic = xSwitch.checked;
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
