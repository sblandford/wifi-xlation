const statsJson = "json/stats.json";

let initialised = false;
let tableObjs = [];

function initTable (json) {
    const table = document.getElementById("stats");
    
    json.forEach( stream => {
        let row = table.insertRow();
        let nameCell = row.insertCell(0);
        let activeCell = row.insertCell(1);
        let listenersCell = row.insertCell(2);
        row.classList.add('stat');
        nameCell.classList.add('stat');
        activeCell.classList.add('stat');
        listenersCell.classList.add('stat');
        tableObjs.push({"row": row, "nameCell" : nameCell, "activeCell" : activeCell, "listenersCell" : listenersCell});
    });
}

function updateTable (statsObj) {
    const table = document.getElementById("stats");
    
    // Set up intial table, it never changes size during session
    if (!initialised) {
        initTable (statsObj);
        initialised = true;
    }

    if (statsObj.length != tableObjs.length) {
        console.error("Table has changed size since initialisation");
    }
    for (let i = 0; i < statsObj.length; i++ ) {
        tableObjs[i].nameCell.innerHTML = statsObj[i].name;
        let statColour = (statsObj[i].active)?'green':'grey';
        let notStatColour = (statsObj[i].active)?'grey':'green';
        tableObjs[i].activeCell.classList.remove(notStatColour);
        tableObjs[i].activeCell.classList.add(statColour);
        tableObjs[i].listenersCell.innerHTML = statsObj[i].listeners;
    }
}

function pollStats () {
    fetch(statsJson, {cache: "no-store"})
        .then((response) => response.json())
        .then((json) => updateTable (json));
}

window.onload = function () {
    pollStats();
    setInterval(pollStats, 5000);
}
