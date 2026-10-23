// Drives plugin/CrossBearingFix.js against a mock of the JavaScript plugin API.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var CBF = require("./load-cbf.js");

function makeHost(wmmReplies) {
    var host = {
        menus: {}, dialogues: [], routes: {}, waypoints: [], messageHandler: null, timers: [], printed: "",
        nextId: 1
    };
    var api = {
        require: function () { return function () { return CBF; }; },
        print: function () { host.printed += Array.prototype.join.call(arguments, ""); },
        OCPNonAllContextMenu: function (h, name) { host.menus[name] = h; return host.nextId++; },
        OCPNonAllWaypointContextMenu: function (h, name) { host.menus[name] = h; return host.nextId++; },
        OCPNgetSingleWaypoint: function (guid) {
            if (guid !== "WP1") throw new Error("no waypoint");
            return { GUID: guid, markName: "Needles Lt", position: { latitude: 50.6623, longitude: -1.5917 } };
        },
        onExit: function (h) { host.onExit = h; },
        onDialogue: function (h, d) { host.dialogues.push({ handler: h, d: d }); },
        onSeconds: function (h) { host.timers.push(h); },
        OCPNonMessageName: function (h) { host.messageHandler = h || null; },
        OCPNsendMessage: function (name, json) {
            host.lastRequest = { name: name, body: JSON.parse(json) };
            if (wmmReplies && host.messageHandler) host.messageHandler(JSON.stringify({ Decl: -1.5 }));
            return "";
        },
        OCPNaddRoute: function (r) { var g = "R" + host.nextId++; host.routes[g] = r; return g; },
        OCPNdeleteRoute: function (g) { if (!host.routes[g]) throw new Error("no route"); delete host.routes[g]; },
        OCPNaddSingleWaypoint: function (w) { host.waypoints.push(w); return "W" + host.nextId++; }
    };
    var ctx = vm.createContext(api);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "plugin", "CrossBearingFix.js"), "utf8"), ctx);
    return host;
}

function lastDialogue(host) { return host.dialogues[host.dialogues.length - 1]; }

// Fill named fields of the latest dialogue and press a button. Like the real
// plugin, the returned copy has a space appended to each field label.
function answer(host, values, button) {
    var dlg = lastDialogue(host);
    var returned = JSON.parse(JSON.stringify(dlg.d));
    returned.forEach(function (e) {
        if (e.type !== "field") return;
        if (values[e.label] !== undefined) e.value = values[e.label];
        if (e.value === undefined) e.value = "";
        e.label += " ";
    });
    dlg.handler(returned, button);
}

var boat = { lat: 50.7700, lon: -1.3000 };
var objects = [
    { name: "Tower", lat: 50.7950, lon: -1.3400 },
    { name: "Church", lat: 50.7900, lon: -1.2500 },
    { name: "Light", lat: 50.7350, lon: -1.2900 }
];

function magBearing(o) { return CBF.trueToCompass(CBF.bearingTo(boat, o), -1.5).toFixed(1); }

function textOf(host) {
    return lastDialogue(host).d.filter(function (e) { return e.type === "text"; })
        .map(function (e) { return e.value; }).join("\n");
}

function field(host, label) {
    return lastDialogue(host).d.filter(function (e) { return e.label === label; })[0].value;
}

var BEARING_HERE = "CBF: bearing to object here";

test("three bearings to a fix mark in the cocked hat", function () {
    var host = makeHost(true);
    assert.deepEqual(Object.keys(host.menus).sort(),
        ["CBF: bearing to object here", "CBF: bearing to this waypoint", "CBF: clear bearings", "CBF: plot fix"]);

    objects.forEach(function (o, i) {
        host.menus[BEARING_HERE]({ latitude: o.lat, longitude: o.lon });
        assert.equal(field(host, "Variation"), "1.5W", "variation prefilled from WMM");
        var buttons = lastDialogue(host).d.filter(function (e) { return e.type === "button"; })[0].label;
        assert.equal(buttons.length, i === 0 ? 3 : 4, "plot button only from the second bearing");
        answer(host, { "Object name": o.name, "Bearing": magBearing(o), "Time": "1432" },
            i < 2 ? "Add more" : "Plot fix");
    });
    assert.equal(host.lastRequest.name, "WMM_VARIATION_REQUEST");
    assert.equal(host.lastRequest.body.Lat, objects[0].lat);

    assert.equal(host.waypoints.length, 1);
    var mark = host.waypoints[0];
    assert.equal(mark.iconName, "Symbol-Circle");
    assert.equal(mark.markName, "Fix 1432");
    var fix = { lat: mark.position.latitude, lon: mark.position.longitude };
    assert.ok(CBF.distanceNm(fix, boat) * 1852 < 15, "fix near boat");
    assert.equal(Object.keys(host.routes).length, 3, "provisional lines replaced, not duplicated");
    assert.match(textOf(host), /Cocked hat/);

    // "New fix" removes the lines but leaves the mark.
    lastDialogue(host).handler(lastDialogue(host).d, "New fix");
    assert.equal(Object.keys(host.routes).length, 0);
    assert.equal(host.waypoints.length, 1);
});

test("bearing to an existing waypoint uses its name and position", function () {
    var host = makeHost(true);
    host.menus["CBF: bearing to this waypoint"]({ latitude: 50.66, longitude: -1.59, GUID: "WP1", objecttype: "Waypoint" });
    assert.equal(field(host, "Object name"), "Needles Lt");
    assert.match(textOf(host), new RegExp(CBF.formatLat(50.6623)));
});

test("clicked position is used exactly; Position... types one", function () {
    var host = makeHost(true);
    var click = { latitude: 50.7912345678, longitude: -1.3456789012 };
    host.menus[BEARING_HERE](click);
    var labels = lastDialogue(host).d.filter(function (e) { return e.type === "field"; })
        .map(function (e) { return e.label; });
    assert.deepEqual(Array.from(labels), ["Object name", "Bearing", "Time", "Variation"], "bearing directly under name, no lat/lon fields");
    assert.match(textOf(host), /Position \(from chart\)/);
    answer(host, { "Bearing": "45" }, "Add more");
    var first = host.routes[Object.keys(host.routes)[0]].waypoints[0].position;
    assert.equal(first.latitude, click.latitude, "not rounded through display text");
    assert.equal(first.longitude, click.longitude);

    // Position... then OK without changes keeps the exact position.
    host.menus[BEARING_HERE](click);
    answer(host, { "Object name": "Spire", "Bearing": "100" }, "Position...");
    assert.equal(lastDialogue(host).d[0].value, "Object position");
    answer(host, {}, "OK");
    assert.equal(field(host, "Object name"), "Spire", "entries kept");
    assert.equal(field(host, "Bearing"), "100");
    assert.match(textOf(host), /from chart/);

    // Typing a position: bad input re-asks, good input replaces it.
    answer(host, {}, "Position...");
    answer(host, { "Latitude": "rubbish" }, "OK");
    assert.match(textOf(host), /Cannot read that/);
    answer(host, { "Latitude": "50 47.70N", "Longitude": "001 20.40W" }, "OK");
    assert.match(textOf(host), /Position \(typed\)/);
    answer(host, {}, "Add more");
    var keys = Object.keys(host.routes);
    var second = host.routes[keys[keys.length - 1]].waypoints[0].position;
    assert.ok(Math.abs(second.latitude - (50 + 47.7 / 60)) < 1e-12);
    assert.ok(Math.abs(second.longitude + (1 + 20.4 / 60)) < 1e-12);
});

test("running fix: same object, 30 minutes apart, with tide", function () {
    var host = makeHost(true);
    var obj = { lat: 50.8000, lon: -1.3000 };
    var start = { lat: 50.7700, lon: -1.3600 };
    // 30 min at 5 kn on 090T, tide 180T at 1 kn. Variation 1.5W, deviation 0.
    var end = CBF.advance(start, 90, 2.5, 180, 0.5);
    function mag(from) { return CBF.trueToCompass(CBF.bearingTo(from, obj), -1.5).toFixed(1); }

    host.menus[BEARING_HERE]({ latitude: obj.lat, longitude: obj.lon });
    answer(host, { "Object name": "Tower", "Bearing": mag(start), "Time": "1000" }, "Add more");
    host.menus[BEARING_HERE]({ latitude: obj.lat, longitude: obj.lon });
    assert.equal(field(host, "Time"), "1000", "time defaults to the previous bearing");
    answer(host, { "Object name": "Tower", "Bearing": mag(end), "Time": "1030" }, "Plot fix");

    assert.equal(lastDialogue(host).d[0].value, "Running fix");
    assert.equal(host.waypoints.length, 0, "no fix until the run is entered");
    answer(host, { "Course steered": "91.5", "Speed through water": "5", "Tidal set": "180", "Tidal rate": "1" },
        "Plot running fix");

    var mark = host.waypoints[0];
    assert.equal(mark.markName, "RFix 1030");
    var fix = { lat: mark.position.latitude, lon: mark.position.longitude };
    assert.ok(CBF.distanceNm(fix, end) * 1852 < 20, "running fix at the 1030 position");
    var routes = Object.keys(host.routes).map(function (k) { return host.routes[k]; });
    assert.equal(routes.filter(function (r) { return r.penStyle === 102; }).length, 1, "advanced line dashed");
    assert.match(textOf(host), /Run: 091\.5°M \(090°T\) at 5\.0 kn, tide 180°T 1\.0 kn/);
});

test("running fix dialogue validates input", function () {
    var host = makeHost(true);
    host.menus[BEARING_HERE]({ latitude: 50.80, longitude: -1.30 });
    answer(host, { "Bearing": "10", "Time": "2350" }, "Add more");
    host.menus[BEARING_HERE]({ latitude: 50.80, longitude: -1.25 });
    answer(host, { "Bearing": "80", "Time": "0010" }, "Plot fix");
    assert.match(textOf(host), /2350 to 0010/, "spans midnight");
    answer(host, { "Course steered": "x", "Speed through water": "5" }, "Plot running fix");
    assert.match(textOf(host), /Course must be/);
    answer(host, { "Course steered": "90", "Speed through water": "" }, "Plot running fix");
    assert.match(textOf(host), /Speed must be/);
});

test("bad bearing re-asks, no WMM falls back to manual variation", function () {
    var host = makeHost(false);
    host.menus[BEARING_HERE]({ latitude: 50.79, longitude: -1.34 });
    assert.equal(host.dialogues.length, 0, "waits for WMM");
    host.timers[0]();
    assert.match(textOf(host), /No reply from WMM plugin/);
    answer(host, { "Bearing": "abc", "Variation": "2W" }, "Add more");
    assert.match(textOf(host), /Bearing must be a number/);
    answer(host, { "Bearing": "045", "Time": "25:00" }, "Add more");
    assert.match(textOf(host), /Time must be hhmm/);
    answer(host, { "Time": "0900" }, "Add more");
    assert.equal(Object.keys(host.routes).length, 1);

    host.menus["CBF: plot fix"]();
    assert.match(textOf(host), /at least two bearings/);
    host.onExit();
    assert.equal(Object.keys(host.routes).length, 0, "lines removed when script stops");
});
