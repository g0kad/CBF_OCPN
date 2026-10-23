// CrossBearingFix.js - cross bearing fix for the OpenCPN JavaScript plugin.
//
// Workflow:
//   1. Take hand bearing compass bearings of 2 or more charted objects.
//   2. For each: right-click the object on the chart, choose
//      "CBF: bearing to object here" and enter the magnetic bearing.
//      The position line is drawn straight away.
//   3. Choose "CBF: plot fix" (from the dialogue or the right-click menu).
//      The lines are trimmed, a fix mark (circle round a dot) named with the
//      time of the first bearing is dropped in the cocked hat, and the
//      results are shown.
//
// Variation comes from OpenCPN's WMM plugin for the first object's position
// and can be overridden in the dialogue. Deviation is taken as zero (normal
// for a hand bearing compass).
//
// ES5 only: the plugin runs scripts in Duktape.

var LIB_PATH = "/home/pi/CBF_OCPN/src/cbf.js";
var CBF = require(LIB_PATH)();

var LINE_COLOUR = "Magenta";     // OpenCPN route colour name
var PROVISIONAL_LINE_NM = 4;     // length of a line before there is a fix
var FIX_ICON = "Symbol-Circle";

var bearings = [];               // {name, object:{lat,lon}, bearing, time, routeGUID}
var variation = null;            // degrees, east positive
var variationSource = "";
var pendingObject = null;        // object position waiting for the dialogue

OCPNonAllContextMenu(onAddObject, "CBF: bearing to object here");
OCPNonAllContextMenu(onPlotMenu, "CBF: plot fix");
OCPNonAllContextMenu(onClearMenu, "CBF: clear bearings");
onExit(function () { deleteLines(); });
print("Cross bearing fix ready. Right-click a charted object and choose 'CBF: bearing to object here'.\n");

// --- adding a bearing ---------------------------------------------------------

function onAddObject(where) {
    pendingObject = { lat: where.latitude, lon: where.longitude };
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
        Lat: pendingObject.lat, Lon: pendingObject.lon,
        Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate()
    }));
    onSeconds(function () {
        if (answered) return;
        answered = true;
        OCPNonMessageName();   // cancel the WMM callback
        showBearingDialogue("No reply from WMM plugin:\nplease enter variation.");
    }, 2);
}

function showBearingDialogue(message, previous) {
    var n = bearings.length + 1;
    var d = [
        { type: "caption", value: "Cross bearing fix - bearing " + n },
        { type: "text", value: "Object at " + CBF.formatLat(pendingObject.lat) + "\n" +
            "               " + CBF.formatLon(pendingObject.lon) }
    ];
    if (message) d.push({ type: "text", value: message });
    d.push(
        { type: "field", label: "Object name", value: previous ? previous.name : "Object " + n, width: 160 },
        { type: "field", label: "Bearing", value: previous ? previous.bearing : "", width: 60, suffix: "°M" },
        { type: "field", label: "Variation", value: previous ? previous.variation : formatVar(variation), width: 60,
            suffix: variationSource === "WMM" ? "(WMM)" : "e.g. 1.5W" }
    );
    if (bearings.length > 0) {
        d.push({ type: "hLine" }, { type: "text", value: bearingList() });
    }
    var buttons = ["Cancel", "*Add"];
    if (bearings.length >= 1) buttons.push("Add & plot fix");
    d.push({ type: "button", label: buttons });
    onDialogue(onBearingDialogue, d);
}

function onBearingDialogue(d, button) {
    if (button === "Cancel") { pendingObject = null; return; }
    var entered = { name: fieldValue(d, "Object name"), bearing: fieldValue(d, "Bearing"),
        variation: fieldValue(d, "Variation") };

    var brg = parseBearing(entered.bearing);
    if (brg === null) { showBearingDialogue("Bearing must be a number\nfrom 0 to 360.", entered); return; }
    var v;
    try { v = CBF.parseVarDev(entered.variation); }
    catch (e) { showBearingDialogue("Cannot read variation '" + entered.variation + "'.\nUse e.g. 1.5W, 2E or 0.", entered); return; }
    if (variation === null || Math.abs(v - variation) > 1e-9) variationSource = "entered";
    variation = v;

    var b = { name: entered.name || ("Object " + (bearings.length + 1)), object: pendingObject,
        bearing: brg, time: new Date() };
    b.routeGUID = drawLine(b, CBF.compassToTrue(brg, variation), PROVISIONAL_LINE_NM);
    bearings.push(b);
    pendingObject = null;
    print("Bearing ", bearings.length, ": ", b.name, " ", pad3(brg), "°M\n");

    if (button === "Add & plot fix") plotFix();
}

// --- plotting the fix -----------------------------------------------------------

function onPlotMenu() { plotFix(); }

function plotFix() {
    if (bearings.length < 2) {
        alertDialogue("Need at least two bearings for a fix (have " + bearings.length + ").");
        return;
    }
    var result;
    try {
        result = CBF.computeFix(bearings, { variation: variation });
    } catch (e) {
        alertDialogue("No fix: " + e.message);
        return;
    }

    // Redraw each line from its object to just past the fix.
    deleteLines();
    for (var i = 0; i < bearings.length; i++) {
        bearings[i].routeGUID = drawLine(bearings[i], result.lines[i].trueBearing,
            Math.max(result.lines[i].rangeNm, 0) + 0.5);
    }

    var t = bearings[0].time;
    var label = "Fix " + pad2(t.getHours()) + pad2(t.getMinutes());
    var summary = resultText(result);
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
        { type: "caption", value: label },
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

function resultText(r) {
    var lines = [];
    lines.push(formatPos(r.fix));
    lines.push("Variation " + formatVar(variation) + (variationSource ? " (" + variationSource + ")" : ""));
    for (var i = 0; i < r.lines.length; i++) {
        var l = r.lines[i];
        lines.push(l.name + ": " + pad3(l.observedBearing) + "°M = " + pad3(l.trueBearing) + "°T, " +
            l.rangeNm.toFixed(1) + " nm");
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

// --- clearing -------------------------------------------------------------------

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

// --- drawing ----------------------------------------------------------------------

// Draw a position line as a two-point route from the object along the
// reciprocal of the true bearing.
function drawLine(b, trueBearing, lengthNm) {
    var ends = CBF.positionLineEnds({ object: b.object, trueBearing: trueBearing, rangeNm: lengthNm }, null, 0);
    return OCPNaddRoute({
        name: "CBF " + b.name + " " + pad3(b.bearing) + "°M",
        description: "Position line: " + b.name + " bearing " + pad3(b.bearing) + "°M",
        isVisible: true,
        colour: LINE_COLOUR,
        waypoints: [routePoint(ends[0]), routePoint(ends[1])]
    });
}

function routePoint(p) {
    return { position: { latitude: p.lat, longitude: p.lon }, markName: "", iconName: "empty",
        isVisible: true, isNameVisible: false };
}

// --- small helpers ------------------------------------------------------------------

// The plugin returns field labels with a trailing space added, so compare trimmed.
function fieldValue(d, label) {
    for (var i = 0; i < d.length; i++) if (d[i].type === "field" && String(d[i].label).trim() === label) return String(d[i].value).trim();
    return "";
}

function parseBearing(s) {
    var m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*[°M]*$/i);
    if (!m) return null;
    var v = parseFloat(m[1]);
    return v >= 0 && v <= 360 ? CBF.norm360(v) : null;
}

function bearingList() {
    var s = [];
    for (var i = 0; i < bearings.length; i++) s.push((i + 1) + ". " + bearings[i].name + "  " + pad3(bearings[i].bearing) + "°M");
    return s.join("\n");
}

function alertDialogue(text) {
    onDialogue(function () {}, [{ type: "caption", value: "Cross bearing fix" }, { type: "text", value: text }]);
}

function formatPos(p) { return CBF.formatLat(p.lat) + "  " + CBF.formatLon(p.lon); }

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
