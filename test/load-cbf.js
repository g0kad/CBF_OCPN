// Load src/cbf.js the way the OpenCPN JavaScript plugin's require() does:
// compile the whole file as a single function expression, then call it.
// If the file stops being a single function expression this throws, so the
// tests also guard plugin compatibility.
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var src = fs.readFileSync(path.join(__dirname, "..", "src", "cbf.js"), "utf8");
module.exports = vm.runInThisContext("(" + src + "\n)", { filename: "cbf.js" })();
