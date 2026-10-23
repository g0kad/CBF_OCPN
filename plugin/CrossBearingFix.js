// CrossBearingFix.js - cross bearing and running fixes for the OpenCPN
// JavaScript plugin.
//
// Cross bearing fix:
//   1. Take hand bearing compass bearings of 2 or more charted objects.
//   2. For each, right-click the object on the chart and choose
//      "CBF: bearing to object here" (or right-click an existing waypoint and
//      choose "CBF: bearing to this waypoint"). Enter the magnetic bearing and
//      the time it was taken. The position can be typed or corrected in the
//      dialogue. The position line is drawn straight away.
//   3. On the last bearing press "Add, last one: plot fix" (or choose
//      "CBF: plot fix" from the right-click menu). The lines are trimmed and a
//      fix mark (circle round a dot) named with the time is dropped in the
//      cocked hat.
//
// Running fix:
//   Enter bearings with different times (the same object twice, or different
//   objects). When the times differ by more than RUNNING_FIX_MINUTES you are
//   asked for course steered, speed and tide; earlier lines are advanced to the
//   time of the last bearing entered and drawn dashed.
//
// Variation comes from OpenCPN's WMM plugin for the first object's position
// and can be overridden. Bearings have no deviation applied (normal for a hand
// bearing compass); the course steered for a running fix can have deviation.
//
// ES5 only: the plugin runs scripts in Duktape.

var LIB_PATH = "/home/pi/CBF_OCPN/src/cbf.js";
var CBF = require(LIB_PATH)();

var LINE_COLOUR = "Magenta";     // OpenCPN route colour name
var DASHED = 102;                // wxPENSTYLE_LONG_DASH, for advanced lines
var PROVISIONAL_LINE_NM = 4;     // length of a line before there is a fix
var FIX_ICON = "Symbol-Circle";
var RUNNING_FIX_MINUTES = 2;     // bearings further apart than this need a run

var BTN_MORE = "Add, more to come";
var BTN_LAST = "Add, last one: plot fix";

var bearings = [];               // {name, object:{lat,lon}, bearing, minutes, routeGUID}
var variation = null;            // degrees, east positive
var variationSource = "";
var pending = null;              // {pos:{lat,lon}, name} waiting for the dialogue
var runEntry = { course: "", deviation: "0", speed: "", set: "", rate: "" };  // remembered

OCPNonAllContextMenu(onChartMenu, "CBF: bearing to object here");
OCPNonAllWaypointContextMenu(onWaypointMenu, "CBF: bearing to this waypoint");
OCPNonAllContextMenu(onPlotMenu, "CBF: plot fix");
OCPNonAllContextMenu(onClearMenu, "CBF: clear bearings");
onExit(function () { deleteLines(); });
print("Cross bearing fix ready. Right-click a charted object and choose 'CBF: bearing to object here'.\n");

// --- choosing the object -------------------------------------------------------------

function onChartMenu(where) {
    startBearing({ lat: where.latitude, lon: where.longitude }, "");
}

function onWaypointMenu(where) {
    var pos = { lat: where.latitude, lon: where.longitude }, name = "";
    try {
        var wp = OCPNgetSingleWaypoint(where.GUID);
        pos = { lat: wp.position.latitude, lon: wp.position.longitude };
        name = wp.markName || "";
    } catch (e) { /* fall back to the clicked position */ }
    startBearing(pos, name);
}

function startBearing(pos, name) {
    pending = { pos: pos, name: name };
    if (variation !== null) { showBearingDialogue(""); return; }

    // Ask WMM for the variation here; fall back to manual entry if no reply.
    var answered = false;
    OCPNonMessageName(function (json) {
        if (answered) return;
        answered = true;
        try {
            variation = JSON.parse(json).Decl;
            variationSource = "WMM";
        } catch (e) { variation = null; }
        showBearingDialogue("");
    }, "WMM_VARIATION");
    var now = new Date();
    OCPNsendMessage("WMM_VARIATION_REQUEST", JSON.stringify({
        Lat: pos.lat, Lon: pos.lon,
        Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate()
    }));
    onSeconds(function () {
        if (answered) return;
        answered = true;
        OCPNonMessageName();   // cancel the WMM callback
        showBearingDialogue("No reply from WMM plugin:\nplease enter variation.");
    }, 2);
}

// --- adding a bearing ------------------------------------------------------------------

function showBearingDialogue(message, previous) {
    var n = bearings.length + 1;
    var p = previous || {
        name: pending.name || ("Object " + n),
        lat: CBF.formatLat(pending.pos.lat),
        lon: CBF.formatLon(pending.pos.lon),
        bearing: "",
        time: bearings.length ? formatTime(bearings[bearings.length - 1].minutes) : formatTime(nowMinutes()),
        variation: formatVar(variation)
    };
    var d = [{ type: "caption", value: "Cross bearing fix - bearing " + n }];
    if (message) d.push({ type: "text", value: message });
    d.push(
        { type: "field", label: "Object name", value: p.name, width: 160 },
        { type: "field", label: "Latitude", value: p.lat, width: 120 },
        { type: "field", label: "Longitude", value: p.lon, width: 120 },
        { type: "field", label: "Bearing", value: p.bearing, width: 60, suffix: "°M" },
        { type: "field", label: "Time", value: p.time, width: 60, suffix: "hhmm" },
        { type: "field", label: "Variation", value: p.variation, width: 60,
            suffix: variationSource === "WMM" ? "(WMM)" : "e.g. 1.5W" }
    );
    if (bearings.length > 0) {
        d.push({ type: "hLine" }, { type: "text", value: bearingList() });
    }
    var buttons = ["Cancel", "*" + BTN_MORE];
    if (bearings.length >= 1) buttons.push(BTN_LAST);
    d.push({ type: "button", label: buttons });
    onDialogue(onBearingDialogue, d);
}

function onBearingDialogue(d, button) {
    if (button === "Cancel") { pending = null; return; }
    var e = { name: fieldValue(d, "Object name"), lat: fieldValue(d, "Latitude"), lon: fieldValue(d, "Longitude"),
        bearing: fieldValue(d, "Bearing"), time: fieldValue(d, "Time"), variation: fieldValue(d, "Variation") };

    var lat = CBF.parseLatLon(e.lat, false), lon = CBF.parseLatLon(e.lon, true);
    if (lat === null || lon === null) {
        showBearingDialogue("Cannot read the position.\nUse e.g. 50 47.13N  001 20.40W", e); return;
    }
    var brg = parseBearing(e.bearing);
    if (brg === null) { showBearingDialogue("Bearing must be a number\nfrom 0 to 360.", e); return; }
    var minutes = parseTime(e.time);
    if (minutes === null) { showBearingDialogue("Time must be hhmm, e.g. 1432.", e); return; }
    var v;
    try { v = CBF.parseVarDev(e.variation); }
    catch (err) { showBearingDialogue("Cannot read variation '" + e.variation + "'.\nUse e.g. 1.5W, 2E or 0.", e); return; }
    if (variation === null || Math.abs(v - variation) > 1e-9) variationSource = "entered";
    variation = v;

    var b = { name: e.name || ("Object " + (bearings.length + 1)), object: { lat: lat, lon: lon },
        bearing: brg, minutes: minutes };
    b.routeGUID = drawLine(b, b.object, CBF.compassToTrue(brg, variation), PROVISIONAL_LINE_NM, false);
    bearings.push(b);
    pending = null;
    print("Bearing ", bearings.length, ": ", b.name, " ", pad3(brg), "°M at ", formatTime(minutes), "\n");

    if (button === BTN_LAST) plotFix();
}

// --- plotting the fix ----------------------------------------------------------------------

function onPlotMenu() { plotFix(); }

function plotFix() {
    if (bearings.length < 2) {
        alertDialogue("Need at least two bearings for a fix (have " + bearings.length + ").");
        return;
    }
    var span = 0;
    for (var i = 0; i < bearings.length; i++) span = Math.max(span, Math.abs(minutesBefore(bearings[i].minutes)));
    if (span > RUNNING_FIX_MINUTES) showRunDialogue("");
    else computeAndPlot(null);
}

// Minutes from time t until the reference time (the last bearing entered),
// allowing for midnight. Negative if t is after the reference time.
function minutesBefore(t) {
    var ref = bearings[bearings.length - 1].minutes;
    var dt = ((ref - t) % 1440 + 1440) % 1440;
    return dt > 720 ? dt - 1440 : dt;
}

function showRunDialogue(message, previous) {
    var p = previous || runEntry;
    var first = bearings[0].minutes, last = bearings[bearings.length - 1].minutes;
    var d = [
        { type: "caption", value: "Running fix" },
        { type: "text", value: "Bearings span " + formatTime(first) + " to " + formatTime(last) + ".\n" +
            "Earlier lines will be advanced to " + formatTime(last) + "\nby the run and the tide." }
    ];
    if (message) d.push({ type: "text", value: message });
    d.push(
        { type: "field", label: "Course steered", value: p.course, width: 60, suffix: "°M" },
        { type: "field", label: "Deviation", value: p.deviation, width: 60, suffix: "e.g. 2W" },
        { type: "field", label: "Speed through water", value: p.speed, width: 60, suffix: "kn" },
        { type: "field", label: "Tidal set", value: p.set, width: 60, suffix: "°T" },
        { type: "field", label: "Tidal rate", value: p.rate, width: 60, suffix: "kn" },
        { type: "button", label: ["Cancel", "*Plot running fix"] }
    );
    onDialogue(onRunDialogue, d);
}

function onRunDialogue(d, button) {
    if (button === "Cancel") return;
    var e = { course: fieldValue(d, "Course steered"), deviation: fieldValue(d, "Deviation"),
        speed: fieldValue(d, "Speed through water"), set: fieldValue(d, "Tidal set"), rate: fieldValue(d, "Tidal rate") };
    runEntry = e;

    var course = parseBearing(e.course);
    if (course === null) { showRunDialogue("Course must be a number from 0 to 360.", e); return; }
    var dev;
    try { dev = CBF.parseVarDev(e.deviation); }
    catch (err) { showRunDialogue("Cannot read deviation '" + e.deviation + "'.", e); return; }
    var speed = parseNumber(e.speed);
    if (speed === null) { showRunDialogue("Speed must be a number of knots.", e); return; }
    var rate = e.rate === "" ? 0 : parseNumber(e.rate);
    var set = e.set === "" ? 0 : parseBearing(e.set);
    if (rate === null || set === null) { showRunDialogue("Tidal set must be 0-360 and rate in knots\n(leave both empty for no tide).", e); return; }

    computeAndPlot({
        courseMag: course, deviation: dev, courseTrue: CBF.compassToTrue(course, variation, dev),
        speed: speed, set: set, rate: rate
    });
}

function computeAndPlot(run) {
    var obs = [];
    for (var i = 0; i < bearings.length; i++) {
        var b = bearings[i], o = { name: b.name, object: b.object, bearing: b.bearing };
        var dt = minutesBefore(b.minutes);
        if (run && dt !== 0) {
            o.run = { courseTrue: run.courseTrue, distanceNm: run.speed * dt / 60,
                setTrue: run.set, driftNm: run.rate * dt / 60 };
        }
        obs.push(o);
    }
    var result;
    try {
        result = CBF.computeFix(obs, { variation: variation });
    } catch (e) {
        alertDialogue("No fix: " + e.message);
        return;
    }

    // Redraw each line from its object (or advanced point) to just past the fix.
    deleteLines();
    var fixTime = formatTime(bearings[bearings.length - 1].minutes);
    for (var j = 0; j < bearings.length; j++) {
        var l = result.lines[j];
        bearings[j].routeGUID = drawLine(bearings[j], l.anchor, l.trueBearing,
            Math.max(l.rangeNm, 0) + 0.5, l.advanced, l.advanced ? fixTime : "");
    }

    var label = (run ? "RFix " : "Fix ") + fixTime;
    var summary = resultText(result, run);
    OCPNaddSingleWaypoint({
        position: { latitude: result.fix.lat, longitude: result.fix.lon },
        markName: label,
        iconName: FIX_ICON,
        isVisible: true,
        isNameVisible: true,
        description: summary
    });
    print(label, "\n", summary, "\n");

    onDialogue(onResultDialogue, [
        { type: "caption", value: run ? "Running fix " + fixTime : "Fix " + fixTime },
        { type: "text", value: summary },
        { type: "button", label: ["Keep lines", "*New fix"] }
    ]);
}

function onResultDialogue(d, button) {
    // The fix mark stays either way. "New fix" removes the lines and bearings.
    if (button === "New fix") clearAll();
    else {
        // Keep the lines on the chart but forget them, so the next fix starts clean.
        for (var i = 0; i < bearings.length; i++) bearings[i].routeGUID = null;
        bearings = [];
    }
}

function resultText(r, run) {
    var lines = [];
    lines.push(CBF.formatLat(r.fix.lat) + "  " + CBF.formatLon(r.fix.lon));
    lines.push("Variation " + formatVar(variation) + (variationSource ? " (" + variationSource + ")" : ""));
    if (run) {
        lines.push("Run: " + pad3(run.courseMag) + "°M (" + pad3(run.courseTrue) + "°T) at " +
            run.speed.toFixed(1) + " kn" + (run.rate ? ", tide " + pad3(run.set) + "°T " + run.rate.toFixed(1) + " kn" : ", no tide"));
    }
    for (var i = 0; i < r.lines.length; i++) {
        var l = r.lines[i];
        lines.push(formatTime(bearings[i].minutes) + " " + l.name + ": " + pad3(l.observedBearing) + "°M = " +
            pad3(l.trueBearing) + "°T" + (l.advanced ? " (advanced)" : ", " + l.rangeNm.toFixed(1) + " nm"));
    }
    if (r.cockedHat) {
        lines.push("Cocked hat: longest side " + r.cockedHat.maxSideNm.toFixed(2) + " nm (" +
            Math.round(r.cockedHat.maxSideNm * 1852) + " m)");
    } else if (r.lines.length > 3) {
        lines.push("Spread of crossings: " + r.spread.toFixed(2) + " nm");
    }
    for (var j = 0; j < r.warnings.length; j++) lines.push("Warning: " + r.warnings[j]);
    return lines.join("\n");
}

// --- clearing ---------------------------------------------------------------------------

function onClearMenu() { clearAll(); }

function clearAll() {
    deleteLines();
    bearings = [];
    print("Bearings cleared.\n");
}

function deleteLines() {
    for (var i = 0; i < bearings.length; i++) {
        if (bearings[i].routeGUID) {
            try { OCPNdeleteRoute(bearings[i].routeGUID); } catch (e) { /* already deleted by user */ }
            bearings[i].routeGUID = null;
        }
    }
}

// --- drawing -------------------------------------------------------------------------------

// Draw a position line as a two-point route from start along the reciprocal of
// the true bearing. Advanced (running fix) lines are dashed.
function drawLine(b, start, trueBearing, lengthNm, advanced, advancedTo) {
    var ends = CBF.positionLineEnds({ anchor: start, trueBearing: trueBearing, rangeNm: lengthNm }, null, 0);
    var name = "CBF " + b.name + " " + pad3(b.bearing) + "°M " + formatTime(b.minutes) +
        (advanced ? " advanced to " + advancedTo : "");
    var route = {
        name: name,
        description: "Position line: " + name,
        isVisible: true,
        colour: LINE_COLOUR,
        waypoints: [routePoint(ends[0]), routePoint(ends[1])]
    };
    if (advanced) route.penStyle = DASHED;
    return OCPNaddRoute(route);
}

function routePoint(p) {
    return { position: { latitude: p.lat, longitude: p.lon }, markName: "", iconName: "empty",
        isVisible: true, isNameVisible: false };
}

// --- small helpers ---------------------------------------------------------------------------

// The plugin returns field labels with a trailing space added, so compare trimmed.
function fieldValue(d, label) {
    for (var i = 0; i < d.length; i++) if (d[i].type === "field" && String(d[i].label).trim() === label) return String(d[i].value).trim();
    return "";
}

function parseBearing(s) {
    var m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*[°MT]*$/i);
    if (!m) return null;
    var v = parseFloat(m[1]);
    return v >= 0 && v <= 360 ? CBF.norm360(v) : null;
}

function parseNumber(s) {
    var m = String(s).trim().match(/^\d+(?:\.\d+)?$/);
    return m ? parseFloat(m[0]) : null;
}

// "1432", "14:32" or "932" -> minutes since midnight
function parseTime(s) {
    var m = String(s).trim().match(/^(\d{1,2}):?(\d{2})$/);
    if (!m) return null;
    var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    return h < 24 && min < 60 ? h * 60 + min : null;
}

function nowMinutes() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

function formatTime(minutes) {
    return pad2(Math.floor(minutes / 60)) + pad2(minutes % 60);
}

function bearingList() {
    var s = [];
    for (var i = 0; i < bearings.length; i++) {
        s.push((i + 1) + ". " + formatTime(bearings[i].minutes) + "  " + bearings[i].name + "  " +
            pad3(bearings[i].bearing) + "°M");
    }
    return s.join("\n");
}

function alertDialogue(text) {
    onDialogue(function () {}, [{ type: "caption", value: "Cross bearing fix" }, { type: "text", value: text }]);
}

function formatVar(v) {
    if (v === null || v === undefined) return "";
    if (Math.abs(v) < 0.05) return "0";
    return Math.abs(v).toFixed(1) + (v < 0 ? "W" : "E");
}

function pad2(n) { return n < 10 ? "0" + n : String(n); }

function pad3(v) {
    var s = (Math.round(v * 10) / 10).toFixed(Math.round(v * 10) % 10 === 0 ? 0 : 1);
    var whole = s.split(".")[0];
    while (whole.length < 3) { whole = "0" + whole; }
    return whole + (s.indexOf(".") >= 0 ? "." + s.split(".")[1] : "");
}
