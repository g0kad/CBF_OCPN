// Run with: node --test
var test = require("node:test");
var assert = require("node:assert/strict");
var CBF = require("./load-cbf.js");

// Roughly Solent-scale geometry: boat mid-channel, three objects 2-4 nm away.
var boat = { lat: 50.7700, lon: -1.3000 };
var objects = [
    { name: "Tower", object: { lat: 50.7950, lon: -1.3400 } },
    { name: "Church", object: { lat: 50.7900, lon: -1.2500 } },
    { name: "Light", object: { lat: 50.7350, lon: -1.2900 } }
];

var M_PER_NM = 1852;

// Bearings a perfect observer at `boat` would take, converted to compass.
function perfectObs(variation, deviation) {
    return objects.map(function (o) {
        return {
            name: o.name, object: o.object,
            bearing: CBF.trueToCompass(CBF.bearingTo(boat, o.object), variation, deviation)
        };
    });
}

test("variation and deviation sign convention", function () {
    assert.equal(CBF.parseVarDev("2.5W"), -2.5);
    assert.equal(CBF.parseVarDev("3E"), 3);
    assert.equal(CBF.parseVarDev("1 30W"), -1.5);
    assert.equal(CBF.parseVarDev("1°30'W"), -1.5);
    assert.equal(CBF.parseVarDev(-2), -2);
    assert.equal(CBF.parseVarDev(""), 0);
    // West is best: compass 100, variation 3W -> true 097
    assert.equal(CBF.compassToTrue(100, "3W"), 97);
    // East is least: compass 100, variation 3E -> true 103
    assert.equal(CBF.compassToTrue(100, "3E"), 103);
    assert.equal(CBF.compassToTrue(359, "2E"), 1);
    assert.equal(CBF.compassToTrue(100, "2W", "1E"), 99);
    assert.throws(function () { CBF.parseVarDev("lots"); });
});

test("angle of cut", function () {
    assert.equal(CBF.angleOfCut(0, 90), 90);
    assert.equal(CBF.angleOfCut(10, 350), 20);
    assert.equal(CBF.angleOfCut(45, 225), 0);
    assert.equal(CBF.angleOfCut(30, 190), 20);
});

test("three perfect bearings recover the boat position", function () {
    var r = CBF.computeFix(perfectObs("1.5W"), { variation: "1.5W" });
    assert.ok(CBF.distanceNm(r.fix, boat) * M_PER_NM < 10, "fix within 10 m");
    assert.ok(r.cockedHat.maxSideNm * M_PER_NM < 10, "cocked hat collapses to a point");
    assert.deepEqual(r.warnings, []);
    r.lines.forEach(function (l, i) {
        var expected = CBF.distanceNm(boat, objects[i].object);
        assert.ok(Math.abs(l.rangeNm - expected) < 0.01, "range to " + l.name);
        assert.ok(Math.abs(CBF.norm360(l.reciprocal - l.trueBearing) - 180) < 1e-9);
    });
});

test("two bearings give a fix but no cocked hat", function () {
    var r = CBF.computeFix(perfectObs(0).slice(0, 2));
    assert.ok(CBF.distanceNm(r.fix, boat) * M_PER_NM < 10);
    assert.equal(r.cockedHat, null);
    assert.equal(r.crossings.length, 1);
});

test("bearing errors produce a cocked hat with the fix inside it", function () {
    var obs = perfectObs(0);
    obs[0].bearing += 2; obs[1].bearing -= 1.5; obs[2].bearing += 1;
    var r = CBF.computeFix(obs);
    var hat = r.cockedHat;
    assert.ok(hat.maxSideNm > 0.05, "hat has real size");
    assert.ok(hat.areaSqNm > 0);
    // Fix is inside the triangle: same-side test on each edge.
    var v = hat.vertices, f = r.fix;
    function side(a, b, p) { return (b.lon - a.lon) * (p.lat - a.lat) - (b.lat - a.lat) * (p.lon - a.lon); }
    var s1 = side(v[0], v[1], f), s2 = side(v[1], v[2], f), s3 = side(v[2], v[0], f);
    assert.ok((s1 > 0 && s2 > 0 && s3 > 0) || (s1 < 0 && s2 < 0 && s3 < 0), "fix inside cocked hat");
    assert.ok(CBF.distanceNm(f, boat) < 0.1);
});

test("nearest-danger corner", function () {
    var obs = perfectObs(0);
    obs[0].bearing += 3; obs[1].bearing -= 3;
    var danger = { lat: 50.7600, lon: -1.3200 };
    var r = CBF.computeFix(obs, { danger: danger });
    var best = r.cockedHat.vertices.reduce(function (a, b) {
        return CBF.distanceNm(a, danger) <= CBF.distanceNm(b, danger) ? a : b;
    });
    assert.deepEqual(r.cockedHat.nearestDanger, best);
});

test("more than three bearings", function () {
    var obs = perfectObs(0).concat([{ name: "Mast", object: { lat: 50.7600, lon: -1.3500 } }]);
    obs[3].bearing = CBF.bearingTo(boat, obs[3].object);
    var r = CBF.computeFix(obs);
    assert.equal(r.crossings.length, 6);
    assert.equal(r.cockedHat, null);
    assert.ok(CBF.distanceNm(r.fix, boat) * M_PER_NM < 10);
});

test("wrong variation sign is caught as a big hat", function () {
    var obs = perfectObs("10W");
    var good = CBF.computeFix(obs, { variation: "10W" });
    var bad = CBF.computeFix(obs, { variation: "10E" });
    assert.ok(bad.cockedHat.maxSideNm > 20 * good.cockedHat.maxSideNm + 0.1);
});

test("warnings: poor cut and parallel lines", function () {
    var a = { object: { lat: 50.80, lon: -1.30 }, bearing: 0, name: "A" };
    var b = { object: { lat: 50.80, lon: -1.29 }, bearing: 10, name: "B" };
    var r = CBF.computeFix([a, b], { trueBearings: true });
    assert.ok(r.warnings.some(function (w) { return /poor angle of cut/.test(w); }));
    var c = { object: { lat: 50.80, lon: -1.29 }, bearing: 0, name: "C" };
    assert.throws(function () { CBF.computeFix([a, c], { trueBearings: true }); });
    assert.throws(function () { CBF.computeFix([a]); });
});

test("position line end points run from object through the fix", function () {
    var r = CBF.computeFix(perfectObs(0));
    r.lines.forEach(function (l) {
        var ends = CBF.positionLineEnds(l, r.fix, 0.5);
        assert.deepEqual(ends[0], l.object);
        assert.ok(Math.abs(CBF.distanceNm(ends[0], ends[1]) - (l.rangeNm + 0.5)) < 0.01);
        assert.ok(Math.abs(CBF.bearingTo(ends[1], ends[0]) - l.trueBearing) < 0.1);
    });
});

test("advance for running fix: course plus tide", function () {
    var p = { lat: 50.8, lon: -1.3 };
    var q = CBF.advance(p, 90, 3, 180, 1);
    assert.ok(Math.abs(CBF.distanceNm(p, q) - Math.sqrt(10)) < 0.01);
    var expected = 90 + Math.atan2(1, 3) * 180 / Math.PI;
    assert.ok(Math.abs(CBF.bearingTo(p, q) - expected) < 0.1);
});

test("formatting degrees and decimal minutes", function () {
    assert.equal(CBF.formatLat(50.5), "50°30.000'N");
    assert.equal(CBF.formatLon(-1.0833333), "001°05.000'W");
    assert.equal(CBF.formatLat(-0.1), "00°06.000'S");
    assert.equal(CBF.formatLat(49.99999999), "50°00.000'N");
});
