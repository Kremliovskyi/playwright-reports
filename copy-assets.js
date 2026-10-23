const fs = require("fs");
const path = require("path");

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

for (const name of ["index.html", "runner.html", "trends.html", "style.css", "trends.css"])
  copy(`src/public/${name}`, `dist/public/${name}`);
for (const [source, name] of [
  [require.resolve("@xterm/xterm"), "xterm.js"],
  [require.resolve("@xterm/addon-fit"), "addon-fit.js"],
  [path.join(path.dirname(require.resolve("@xterm/xterm")), "../css/xterm.css"), "xterm.css"],
  [path.join(path.dirname(require.resolve("@xterm/xterm")), "../LICENSE"), "xterm-LICENSE"],
  [path.join(path.dirname(require.resolve("@xterm/addon-fit")), "../LICENSE"), "addon-fit-LICENSE"],
])
  copy(source, path.join("dist/public/vendor", name));
