function CBFLibrary() {
    // cbf.js - cross bearing fix maths.
    //
    // Written in ES5 (var, function, no arrows or template strings) so the same
    // file runs under Node for testing and under the Duktape engine used by the
    // OpenCPN JavaScript plugin.
    //
    // Conventions
    //   Positions:   {lat, lon} in decimal degrees, north and east positive.
    //   Bearings:    degrees 0-360, clockwise from north.
    //   Variation and deviation: degrees, EAST POSITIVE, WEST NEGATIVE.
    //     True = Compass + Deviation + Variation   ("East is least, West is best":
    //     going True -> Compass you subtract East and add West, so going
    //     Compass -> True you add East and subtract West.)
    //   Distances:   nautical miles.
    //
    // Geometry uses a local flat-earth (equirectangular) projection centred on the
    // observed objects. For bearings to objects a few miles away this is accurate
    // to a few metres, far better than a hand bearing compass.
    //
    // The whole file is one function expression because the JavaScript plugin's
    // require() compiles a file as a single function and returns it. Use:
    //     CBF = require("/path/to/cbf.js")();
    // Under Node, load it with test/load-cbf.js.

    var NM_PER_DEG = 60;
    var DEG = Math.PI / 180;

    function norm360(deg) {
        var d = deg % 360;
        return d < 0 ? d + 360 : d;
    }

    // Parse variation/deviation: a number (east positive), or a string such as
    // "2.5W", "3E", "1 30W" or "1°30'W". Returns degrees, east positive.
    function parseVarDev(v) {
        if (typeof v === "number") return v;
        if (v === undefined || v === null) return 0;
        var s = String(v).trim().toUpperCase();
        if (s === "") return 0;
        var m = s.match(/^([+-]?\d+(?:\.\d+)?)(?:[°\s]+(\d+(?:\.\d+)?)'?)?\s*([EW])?$/);
        if (!m) throw new Error("Cannot read variation/deviation: " + v);
        var deg = parseFloat(m[1]) + (m[2] ? parseFloat(m[2]) / 60 : 0);
        if (m[3] === "W") deg = -Math.abs(deg);
        else if (m[3] === "E") deg = Math.abs(deg);
        return deg;
    }

    // Compass or magnetic bearing to true. Deviation defaults to 0, which is usual
    // for a hand bearing compass used away from the steering compass.
    function compassToTrue(compass, variation, deviation) {
        return norm360(compass + parseVarDev(deviation) + parseVarDev(variation));
    }

    function trueToCompass(trueBrg, variation, deviation) {
        return norm360(trueBrg - parseVarDev(deviation) - parseVarDev(variation));
    }

    // --- local projection --------------------------------------------------------

    function makeProjection(origin) {
        var k = Math.cos(origin.lat * DEG);
        return {
            origin: origin,
            toXY: function (p) {
                return { x: (p.lon - origin.lon) * k * NM_PER_DEG, y: (p.lat - origin.lat) * NM_PER_DEG };
            },
            toLL: function (q) {
                return { lat: origin.lat + q.y / NM_PER_DEG, lon: origin.lon + q.x / (k * NM_PER_DEG) };
            }
        };
    }

    function meanPosition(points) {
        var lat = 0, lon = 0;
        for (var i = 0; i < points.length; i++) { lat += points[i].lat; lon += points[i].lon; }
        return { lat: lat / points.length, lon: lon / points.length };
    }

    // Unit vector pointing along a bearing, in x (east) / y (north).
    function dirVec(brg) {
        return { x: Math.sin(brg * DEG), y: Math.cos(brg * DEG) };
    }

    // --- position lines ----------------------------------------------------------

    // A position line runs from the object back towards the observer, i.e. along
    // the reciprocal of the true bearing. In local XY it is stored as the object
    // point p and unit direction u of the OBSERVED bearing; the observer is at
    // p - t*u for some t > 0 (t = range to the object).
    function positionLine(proj, obs) {
        return {
            p: proj.toXY(obs.object),
            u: dirVec(obs.trueBearing),
            obs: obs
        };
    }

    // Intersect two position lines. Returns null when they are (near) parallel.
    // t1, t2 are the ranges from the observer to each object; a negative range
    // means the crossing is on the wrong side of an object (bad data).
    function intersect(l1, l2) {
        // p1 - t1*u1 = p2 - t2*u2  =>  t1*u1 - t2*u2 = p1 - p2
        var det = -l1.u.x * l2.u.y + l1.u.y * l2.u.x;
        if (Math.abs(det) < 1e-9) return null;
        var dx = l1.p.x - l2.p.x, dy = l1.p.y - l2.p.y;
        var t1 = (-dx * l2.u.y + dy * l2.u.x) / det;
        var t2 = (l1.u.x * dy - l1.u.y * dx) / det;
        return {
            xy: { x: l1.p.x - t1 * l1.u.x, y: l1.p.y - t1 * l1.u.y },
            t1: t1,
            t2: t2
        };
    }

    // Angle of cut between two bearings, 0-90 degrees. Below about 30 the fix is
    // poorly defined along the lines.
    function angleOfCut(b1, b2) {
        var a = Math.abs(norm360(b1 - b2)) % 180;
        return a > 90 ? 180 - a : a;
    }

    // Point minimising the sum of squared perpendicular distances to all lines.
    // For three lines this lies inside the cocked hat.
    function leastSquaresPoint(lines) {
        var a = 0, b = 0, c = 0, d = 0, e = 0;
        for (var i = 0; i < lines.length; i++) {
            var n = { x: lines[i].u.y, y: -lines[i].u.x };   // unit normal
            var k = n.x * lines[i].p.x + n.y * lines[i].p.y;
            a += n.x * n.x; b += n.x * n.y; c += n.y * n.y;
            d += n.x * k;   e += n.y * k;
        }
        var det = a * c - b * b;
        if (Math.abs(det) < 1e-12) return null;
        return { x: (c * d - b * e) / det, y: (a * e - b * d) / det };
    }

    function perpDistance(line, q) {
        // signed distance is the cross product of u with (q - p)
        return Math.abs(line.u.x * (q.y - line.p.y) - line.u.y * (q.x - line.p.x));
    }

    function dist(a, b) {
        return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
    }

    // --- the fix -------------------------------------------------------------------

    // observations: array of {
    //     object:  {lat, lon},          charted position of the object
    //     bearing: number,              observed bearing TO the object
    //     name:    string (optional)
    // }
    // options: {
    //     variation: number|string,    east positive, or "2.5W" etc. Default 0.
    //     deviation: number|string,    applied to every bearing. Default 0.
    //     trueBearings: bool,          bearings are already true. Default false.
    //     danger: {lat, lon}            optional; report the corner nearest it.
    // }
    //
    // Returns {
    //     fix: {lat, lon},             best estimate (least squares; inside the hat)
    //     lines: [...],                per observation: true bearing, reciprocal,
    //                                  range to object, residual distance from fix
    //     crossings: [...],            every pairwise intersection
    //     cockedHat: {...} | null,     for exactly 3 lines: vertices, area, sides
    //     spread: number,              largest distance from fix to any crossing (nm)
    //     warnings: [string]
    // }
    function computeFix(observations, options) {
        options = options || {};
        if (!observations || observations.length < 2) throw new Error("Need at least two bearings for a fix");

        var proj = makeProjection(meanPosition(observations.map(function (o) { return o.object; })));
        var warnings = [];

        var lines = observations.map(function (o, i) {
            var tb = options.trueBearings ? norm360(o.bearing)
                : compassToTrue(o.bearing, options.variation, o.deviation !== undefined ? o.deviation : options.deviation);
            return positionLine(proj, {
                object: o.object, name: o.name || ("Object " + (i + 1)),
                bearing: o.bearing, trueBearing: tb
            });
        });

        var crossings = [];
        for (var i = 0; i < lines.length; i++) {
            for (var j = i + 1; j < lines.length; j++) {
                var cut = angleOfCut(lines[i].obs.trueBearing, lines[j].obs.trueBearing);
                var x = intersect(lines[i], lines[j]);
                if (!x) {
                    warnings.push(lines[i].obs.name + " and " + lines[j].obs.name + " lines are parallel");
                    continue;
                }
                if (cut < 30) warnings.push(lines[i].obs.name + " / " + lines[j].obs.name +
                    ": poor angle of cut (" + cut.toFixed(0) + "°)");
                if (x.t1 < 0 || x.t2 < 0) warnings.push(lines[i].obs.name + " / " + lines[j].obs.name +
                    ": lines cross on the far side of an object - check bearings and variation sign");
                crossings.push({ a: i, b: j, xy: x.xy, pos: proj.toLL(x.xy), angleOfCut: cut });
            }
        }

        var fixXY = leastSquaresPoint(lines);
        if (!fixXY) throw new Error("Position lines are all parallel - no fix");

        var spread = 0;
        crossings.forEach(function (c) { spread = Math.max(spread, dist(c.xy, fixXY)); });

        var cockedHat = null;
        if (lines.length === 3 && crossings.length === 3) {
            var v = crossings.map(function (c) { return c.xy; });
            var area = Math.abs((v[1].x - v[0].x) * (v[2].y - v[0].y) - (v[2].x - v[0].x) * (v[1].y - v[0].y)) / 2;
            var sides = [dist(v[0], v[1]), dist(v[1], v[2]), dist(v[2], v[0])];
            cockedHat = {
                vertices: crossings.map(function (c) { return c.pos; }),
                areaSqNm: area,
                maxSideNm: Math.max(sides[0], sides[1], sides[2]),
                centroid: proj.toLL({ x: (v[0].x + v[1].x + v[2].x) / 3, y: (v[0].y + v[1].y + v[2].y) / 3 })
            };
            if (options.danger) {
                var dXY = proj.toXY(options.danger), best = 0;
                for (var k = 1; k < 3; k++) if (dist(v[k], dXY) < dist(v[best], dXY)) best = k;
                cockedHat.nearestDanger = crossings[best].pos;
            }
        }

        return {
            fix: proj.toLL(fixXY),
            lines: lines.map(function (l) {
                // range: distance from fix to object measured along the line
                var range = (l.p.x - fixXY.x) * l.u.x + (l.p.y - fixXY.y) * l.u.y;
                return {
                    name: l.obs.name,
                    object: l.obs.object,
                    observedBearing: l.obs.bearing,
                    trueBearing: l.obs.trueBearing,
                    reciprocal: norm360(l.obs.trueBearing + 180),
                    rangeNm: range,
                    residualNm: perpDistance(l, fixXY)
                };
            }),
            crossings: crossings.map(function (c) { return { a: c.a, b: c.b, pos: c.pos, angleOfCut: c.angleOfCut }; }),
            cockedHat: cockedHat,
            spread: spread,
            warnings: warnings
        };
    }

    // End points for drawing a position line: from the object, along the
    // reciprocal, to a little beyond the fix.
    function positionLineEnds(line, fix, overrunNm) {
        var proj = makeProjection(line.object);
        var u = dirVec(line.trueBearing);
        var len = Math.max(line.rangeNm, 0) + (overrunNm === undefined ? 0.5 : overrunNm);
        return [line.object, proj.toLL({ x: -len * u.x, y: -len * u.y })];
    }

    // --- running fix support ------------------------------------------------------

    // Move a position (e.g. the object of an earlier line) by the boat's run:
    // course and distance through the water, plus optional tidal set and drift.
    // Advancing the object by the run advances the whole position line.
    function advance(pos, courseTrue, distanceNm, setTrue, driftNm) {
        var proj = makeProjection(pos);
        var c = dirVec(courseTrue), s = dirVec(setTrue || 0);
        var dr = driftNm || 0;
        return proj.toLL({ x: c.x * distanceNm + s.x * dr, y: c.y * distanceNm + s.y * dr });
    }

    // --- helpers for testing and display -----------------------------------------

    // Initial great-circle bearing from a to b (true).
    function bearingTo(a, b) {
        var p1 = a.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
        var y = Math.sin(dl) * Math.cos(p2);
        var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return norm360(Math.atan2(y, x) / DEG);
    }

    // Great-circle distance in nm.
    function distanceNm(a, b) {
        var p1 = a.lat * DEG, p2 = b.lat * DEG;
        var dp = p2 - p1, dl = (b.lon - a.lon) * DEG;
        var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * Math.asin(Math.sqrt(h)) / DEG * NM_PER_DEG;
    }

    function pad(n, width) {
        var s = String(n);
        while (s.length < width) s = "0" + s;
        return s;
    }

    // 50.123456 -> "50°07.407'N"
    function formatLat(lat) { return formatDDM(lat, 2, "N", "S"); }
    function formatLon(lon) { return formatDDM(lon, 3, "E", "W"); }

    function formatDDM(v, degWidth, pos, neg) {
        var h = v < 0 ? neg : pos;
        var a = Math.abs(v);
        var d = Math.floor(a);
        var m = (a - d) * 60;
        if (m >= 59.9995) { d += 1; m = 0; }
        var ms = m.toFixed(3);
        if (m < 10) ms = "0" + ms;
        return pad(d, degWidth) + "°" + ms + "'" + h;
    }

    var CBF = {
        norm360: norm360,
        parseVarDev: parseVarDev,
        compassToTrue: compassToTrue,
        trueToCompass: trueToCompass,
        angleOfCut: angleOfCut,
        computeFix: computeFix,
        positionLineEnds: positionLineEnds,
        advance: advance,
        bearingTo: bearingTo,
        distanceNm: distanceNm,
        formatLat: formatLat,
        formatLon: formatLon
    };

    return CBF;
}
