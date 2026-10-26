import type { Express } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getBasePathForScope } from "./report-storage";

const recoveryScript = "playwright-reports-trace-recovery.js";

export function registerTraceViewerRoutes(app: Express): void {
  app.get(
    /^\/reports\/(current|archive)\/((?:[^/]+\/)+trace\/)(index\.html|playwright-reports-trace-recovery\.js)?$/,
    async (req, res) => {
      const root = getBasePathForScope(req.params[0] === "current" ? "current" : "archive");
      if (!root) {
        res.status(404).send("Report storage is not configured.");
        return;
      }
      const directory = path.resolve(root, req.params[1]);
      const relative = path.relative(path.resolve(root), directory);
      if (
        !relative || path.isAbsolute(relative) || relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        req.params[1].split(/[\\/]/).some(part => part.startsWith("."))
      ) {
        res.status(403).send("Trace viewer path is outside the served report directories.");
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      if (req.params[2] === recoveryScript) {
        res.sendFile(path.join(__dirname, "public", recoveryScript));
        return;
      }
      try {
        const html = await fs.readFile(path.join(directory, "index.html"), "utf8");
        const head = /<head(?:\s[^>]*)?>/i;
        if (!head.test(html))
          console.warn("Trace viewer recovery was not added: HTML has no head element.", req.path);
        // The helper must be inside the viewer's scope: its worker treats outside URLs as snapshot resources.
        res.type("html").send(html.replace(head, `$&<script src="./${recoveryScript}"></script>`));
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "ENOENT" || code === "ENOTDIR") {
          res.status(404).send("Trace viewer not found.");
          return;
        }
        console.error("Failed to serve trace viewer:", error);
        res.status(500).send("Failed to read the trace viewer.");
      }
    },
  );
}
