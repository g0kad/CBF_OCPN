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

test("three bearings to a fix mark in the cocked hat", function () {
    var host = makeHost(true);
    assert.deepEqual(Object.keys(host.menus).sort(),
        ["CBF: bearing to object here", "CBF: clear bearings", "CBF: plot fix"]);

    objects.forEach(function (o, i) {
        host.menus["CBF: bearing to object here"]({ latitude: o.lat, longitude: o.lon });
        var field = lastDialogue(host).d.filter(function (e) { return e.label === "Variation"; })[0];
        assert.equal(field.value, "1.5W", "variation prefilled from WMM");
        answer(host, { "Object name": o.name, "Bearing": magBearing(o) }, i < 2 ? "Add" : "Add & plot fix");
    });
    assert.equal(host.lastRequest.name, "WMM_VARIATION_REQUEST");
    assert.equal(host.lastRequest.body.Lat, objects[0].lat);

    assert.equal(host.waypoints.length, 1);
    var mark = host.waypoints[0];
    assert.equal(mark.iconName, "Symbol-Circle");
    assert.match(mark.markName, /^Fix \d{4}$/);
    var fix = { lat: mark.position.latitude, lon: mark.position.longitude };
    assert.ok(CBF.distanceNm(fix, boat) * 1852 < 15, "fix near boat");
    assert.equal(Object.keys(host.routes).length, 3, "provisional lines replaced, not duplicated");
    assert.match(lastDialogue(host).d[1].value, /Cocked hat/);

    // "New fix" removes the lines but leaves the mark.
    lastDialogue(host).handler(lastDialogue(host).d, "New fix");
    assert.equal(Object.keys(host.routes).length, 0);
    assert.equal(host.waypoints.length, 1);
});

test("bad bearing re-asks, no WMM falls back to manual variation", function () {
    var host = makeHost(false);
    host.menus["CBF: bearing to object here"]({ latitude: 50.79, longitude: -1.34 });
    assert.equal(host.dialogues.length, 0, "waits for WMM");
    host.timers[0]();
    assert.match(lastDialogue(host).d[2].value, /No reply from WMM plugin/);
    answer(host, { "Bearing": "abc", "Variation": "2W" }, "Add");
    assert.match(lastDialogue(host).d[2].value, /Bearing must be a number/);
    answer(host, { "Bearing": "045" }, "Add");
    assert.equal(Object.keys(host.routes).length, 1);

    host.menus["CBF: plot fix"]();
    assert.match(lastDialogue(host).d[1].value, /at least two bearings/);
    host.onExit();
    assert.equal(Object.keys(host.routes).length, 0, "lines removed when script stops");
});
