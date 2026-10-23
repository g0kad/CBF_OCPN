# CBF_OCPN: cross bearing fixes for OpenCPN

A script for the [OpenCPN JavaScript plugin](https://github.com/antipole2/JavaScript_pi) that plots
cross-bearing fixes and running fixes when GPS is unavailable.

- Right-click a charted object and choose **CBF: bearing to object here** (or right-click a waypoint and
  choose **CBF: bearing to this waypoint**). Enter the magnetic bearing and the time it was taken. The
  position can be typed or corrected in the dialogue.
- Variation is filled in from OpenCPN's WMM plugin and can be overridden.
- Each position line is drawn as it is entered. On the last bearing, **Add, last one: plot fix** trims the
  lines and drops a fix mark (circle round a dot) named with the time, and reports the cocked hat size.
- If the bearing times differ by more than 2 minutes, it asks for course steered, speed and tide, and plots
  a **running fix**: earlier lines are advanced to the time of the last bearing and drawn dashed.

## Install

1. Install the JavaScript plugin from OpenCPN's plugin manager.
2. Copy `src/cbf.js` and `plugin/CrossBearingFix.js` to the OpenCPN machine (`scripts/deploy.sh` does
   this for a Raspberry Pi at `openplotter.local`), and set `LIB_PATH` at the top of
   `CrossBearingFix.js` to where `cbf.js` lives.
3. In a JavaScript console, load `CrossBearingFix.js` and press **Run**. Tick auto-run to start it with
   OpenCPN.

## Conventions

Variation and deviation are east positive: True = Compass + Deviation + Variation ("East is least, West is
best"). Hand bearings have no deviation applied; the course steered for a running fix can.

## Development

`src/cbf.js` holds the maths. It is ES5 and written as a single function expression, because the plugin's
`require()` compiles a file that way. `npm test` runs the maths tests and a smoke test that drives the
plugin script against a mock of the plugin API.
