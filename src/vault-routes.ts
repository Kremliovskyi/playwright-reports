import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import MarkdownIt from "markdown-it";
import path from "path";
import {
  GROUPED_ANALYSIS_FILENAME
} from "./copilot-grouper";
import {
  getAllAnalysisRuns
} from "./db";
import {
  contentVersion
} from "./report-artifacts";
import { AGENT_API_SCHEMA_VERSION } from "./report-catalog";
import { appConfig, refreshConfigCache, reportIsBusy } from "./runtime";
import { resolveGroupedAnalysisFile, resolveVaultFile } from "./vault-files";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const renderVaultPage = (
  filename: string,
  rawContent: string,
  saveUrl: string
): string => {
  const rendered = md.render(rawContent);
  const escapedRaw = rawContent
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${filename} — Analysis</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0d1117; --bg-surface: #161b22; --bg-surface-hover: #1c2129;
      --text-primary: #e6edf3; --text-secondary: #7d8590;
      --border-color: #30363d; --primary: #58a6ff;
      --radius-md: 6px; --radius-lg: 8px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text-primary); line-height: 1.6; }
    .vault-header {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; justify-content: space-between;
      padding: 1rem 2rem; background: var(--bg-surface); border-bottom: 1px solid var(--border-color);
    }
    .vault-header h1 { font-size: 1.1rem; font-weight: 600; }
    .vault-header-actions { display: flex; gap: 0.5rem; align-items: center; }
    .vault-btn {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.4rem 0.85rem; font-size: 0.8rem; font-weight: 500;
      border-radius: var(--radius-md); border: 1px solid var(--border-color);
      background: transparent; color: var(--text-primary); cursor: pointer;
      font-family: inherit; transition: all 0.15s ease;
    }
    .vault-btn:hover { background: var(--bg-surface-hover); border-color: var(--text-secondary); }
    .vault-btn.primary { background: #238636; border-color: #238636; color: #fff; }
    .vault-btn.primary:hover { background: #2ea043; }
    .vault-btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .vault-back { color: var(--text-secondary); text-decoration: none; font-size: 0.85rem; }
    .vault-back:hover { color: var(--primary); }
    .vault-content {
      max-width: 1280px; width: calc(100% - 4rem); margin: 1.5rem auto; padding: 2.5rem 3rem;
      background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-lg);
    }
    .vault-content h1, .vault-content h2, .vault-content h3, .vault-content h4 { margin: 1.5em 0 0.5em; font-weight: 600; border-bottom: 1px solid var(--border-color); padding-bottom: 0.3em; }
    .vault-content h1 { font-size: 1.6rem; } .vault-content h2 { font-size: 1.3rem; } .vault-content h3 { font-size: 1.1rem; border-bottom: none; }
    .vault-content p { margin: 0.8em 0; }
    .vault-content a { color: var(--primary); text-decoration: none; } .vault-content a:hover { text-decoration: underline; }
    .vault-content ul, .vault-content ol { margin: 0.8em 0; padding-left: 2em; }
    .vault-content li { margin: 0.3em 0; }
    .vault-content code { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 0.85em; background: rgba(110,118,129,0.15); padding: 0.2em 0.4em; border-radius: 3px; }
    .vault-content pre { background: var(--bg); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1rem; overflow-x: auto; margin: 1em 0; }
    .vault-content pre code { background: none; padding: 0; }
    .vault-content blockquote { border-left: 3px solid var(--primary); padding: 0.5em 1em; margin: 1em 0; color: var(--text-secondary); background: rgba(88,166,255,0.05); border-radius: 0 var(--radius-md) var(--radius-md) 0; }
    .vault-content table { width: 100%; border-collapse: collapse; margin: 1em 0; }
    .vault-content th, .vault-content td { border: 1px solid var(--border-color); padding: 0.5em 0.75em; text-align: left; }
    .vault-content th { background: var(--bg); font-weight: 600; }
    .vault-content hr { border: none; border-top: 1px solid var(--border-color); margin: 1.5em 0; }
    .vault-content img { max-width: 100%; border-radius: var(--radius-md); }
    .vault-editor {
      width: 100%; min-height: 80vh; padding: 1rem;
      font-family: 'SFMono-Regular', Consolas, monospace; font-size: 0.875rem;
      background: var(--bg); color: var(--text-primary);
      border: 1px solid var(--border-color); border-radius: var(--radius-md);
      resize: vertical; line-height: 1.6; tab-size: 2;
    }
    .vault-editor:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 2px rgba(88,166,255,0.2); }
    .hidden { display: none !important; }
    .vault-status { font-size: 0.8rem; color: var(--text-secondary); }
    .vault-status.success { color: #3fb950; }
    .vault-status.error { color: #f85149; }
  </style>
</head>
<body>
  <div class="vault-header">
    <div style="display:flex;align-items:center;gap:1rem;">
      <a href="/" class="vault-back">← Dashboard</a>
      <h1>${filename}</h1>
    </div>
    <div class="vault-header-actions">
      <span id="save-status" class="vault-status"></span>
      <button id="edit-btn" class="vault-btn" onclick="toggleEdit()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        Edit
      </button>
      <button id="save-btn" class="vault-btn primary hidden" onclick="saveContent()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>
        Save
      </button>
      <button id="cancel-btn" class="vault-btn hidden" onclick="cancelEdit()">Cancel</button>
    </div>
  </div>
  <main>
    <article id="view-container" class="vault-content">${rendered}</article>
    <div id="edit-container" class="vault-content hidden">
      <textarea id="editor" class="vault-editor">${escapedRaw}</textarea>
    </div>
  </main>
  <script>
    const saveUrl = ${JSON.stringify(saveUrl)};
    const expectedVersion = ${JSON.stringify(contentVersion(rawContent))};
    const editBtn = document.getElementById('edit-btn');
    const saveBtn = document.getElementById('save-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const viewContainer = document.getElementById('view-container');
    const editContainer = document.getElementById('edit-container');
    const editor = document.getElementById('editor');
    const saveStatus = document.getElementById('save-status');
    let isEditing = false;

    function toggleEdit() {
      isEditing = true;
      viewContainer.classList.add('hidden');
      editContainer.classList.remove('hidden');
      editBtn.classList.add('hidden');
      saveBtn.classList.remove('hidden');
      cancelBtn.classList.remove('hidden');
      saveStatus.textContent = '';
      editor.focus();
    }

    function cancelEdit() {
      isEditing = false;
      editContainer.classList.add('hidden');
      viewContainer.classList.remove('hidden');
      editBtn.classList.remove('hidden');
      saveBtn.classList.add('hidden');
      cancelBtn.classList.add('hidden');
      saveStatus.textContent = '';
    }

    async function saveContent() {
      saveBtn.disabled = true;
      saveStatus.textContent = 'Saving...';
      saveStatus.className = 'vault-status';
      try {
        const res = await fetch(saveUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: editor.value, expectedVersion })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        saveStatus.textContent = 'Saved';
        saveStatus.className = 'vault-status success';
        setTimeout(() => { window.location.reload(); }, 600);
      } catch (err) {
        saveStatus.textContent = err.message;
        saveStatus.className = 'vault-status error';
      } finally {
        saveBtn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
};

export function registerVaultRoutes(app: Express): void {

  app.get("/api/vault/list", (req: Request, res: Response): any => {
    refreshConfigCache();
    try {
      const files: { filename: string; mtime: string }[] = [];
      // Scan vaultPath (current reports)
      if (appConfig.vaultPath && fs.existsSync(appConfig.vaultPath)) {
        const entries = fs.readdirSync(appConfig.vaultPath, {
          withFileTypes: true
        });
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith(".md")) {
            const filePath = path.join(appConfig.vaultPath, e.name);
            const stat = fs.statSync(filePath);
            files.push({
              filename: e.name.replace(/\.md$/, ""),
              mtime: stat.mtime.toISOString()
            });
          }
        }
      }
      // Scan archivePath/analysis/ (archived reports)
      if (appConfig.archivePath) {
        const analysisDir = path.join(appConfig.archivePath, "analysis");
        if (fs.existsSync(analysisDir)) {
          const entries = fs.readdirSync(analysisDir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isFile() && e.name.endsWith(".md")) {
              const filePath = path.join(analysisDir, e.name);
              const stat = fs.statSync(filePath);
              files.push({
                filename: e.name.replace(/\.md$/, ""),
                mtime: stat.mtime.toISOString()
              });
            }
          }
        }
      }
      files.sort(
        (a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime()
      );
      return res.json({ files });
    } catch (error: any) {
      console.error("Vault list error:", error.message);
      return res.status(500).json({ error: "Failed to list vault files" });
    }
  });

  app.get("/api/vault/:filename/raw", (req: Request, res: Response): any => {
    refreshConfigCache();
    const filename = req.params.filename as string;
    const resolved = resolveVaultFile(filename);
    if (!resolved) return res.status(404).json({ error: "Vault file not found" });
    try {
      const content = fs.readFileSync(resolved, "utf-8");
      res.type("text/markdown").send(content);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to read vault file" });
    }
  });

  app.put("/api/vault/:filename", (req: Request, res: Response): any => {
    refreshConfigCache();
    const filename = req.params.filename as string;
    const safeName = path.basename(filename);
    const content = req.body.content;
    if (typeof content !== "string")
      return res.status(400).json({ error: "content is required" });

    // Try to resolve existing file first (covers both vaultPath and archivePath/analysis/)
    const existing = resolveVaultFile(safeName.replace(/\.md$/, ""));
    if (req.body.expectedVersion !== undefined) {
      if (
        !existing ||
        contentVersion(fs.readFileSync(existing, "utf8")) !==
        req.body.expectedVersion
      )
        return res.status(409).json({
          error: "This analysis was changed or deleted. Reload before saving."
        });
    }
    const owningRun = getAllAnalysisRuns().find(
      (run) => run.runName === safeName.replace(/\.md$/, "")
    );
    if (owningRun && reportIsBusy(owningRun.reportId))
      return res.status(409).json({
        error: "Wait for this report's active operation before saving."
      });
    if (existing) {
      try {
        fs.writeFileSync(existing, content, "utf-8");
        return res.json({ success: true });
      } catch (error: any) {
        console.error("Vault save error:", error.message);
        return res.status(500).json({ error: "Failed to save vault file" });
      }
    }

    // New file — write to vaultPath
    if (!appConfig.vaultPath)
      return res.status(400).json({ error: "Vault path not configured" });
    const resolved = path.resolve(appConfig.vaultPath, safeName + ".md");
    const base = path.resolve(appConfig.vaultPath);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return res.status(400).json({ error: "Invalid file path" });
    }
    try {
      fs.writeFileSync(resolved, content, "utf-8");
      return res.json({ success: true });
    } catch (error: any) {
      console.error("Vault save error:", error.message);
      return res.status(500).json({ error: "Failed to save vault file" });
    }
  });

  app.get("/vault/:filename", (req: Request, res: Response): any => {
    refreshConfigCache();
    const filename = req.params.filename as string;
    const resolved = resolveVaultFile(filename);
    if (!resolved) return res.status(404).send("Vault file not found");
    try {
      const content = fs.readFileSync(resolved, "utf-8");
      const html = renderVaultPage(
        filename,
        content,
        `/api/vault/${encodeURIComponent(filename)}`
      );
      res.type("text/html").send(html);
    } catch (error: any) {
      res.status(500).send("Failed to render vault file");
    }
  });

  app.get("/grouped-analysis", (req: Request, res: Response): any => {
    refreshConfigCache();
    const reportId =
      typeof req.query.reportId === "string" ? req.query.reportId : "";
    const runName =
      typeof req.query.runName === "string" ? req.query.runName : "";
    if (!reportId || !runName)
      return res.status(400).send("reportId and runName are required");
    try {
      const resolved = resolveGroupedAnalysisFile(reportId, runName);
      if (!resolved) return res.status(404).send("Grouped analysis file not found");
      const content = fs.readFileSync(resolved, "utf-8");
      const saveUrl = `/api/analysis-run/grouped-analysis?reportId=${encodeURIComponent(reportId)}&runName=${encodeURIComponent(runName)}`;
      res
        .type("text/html")
        .send(renderVaultPage(GROUPED_ANALYSIS_FILENAME, content, saveUrl));
    } catch (error) {
      console.error("Grouped analysis render error:", error);
      res.status(500).send("Failed to render grouped analysis file");
    }
  });

  app.put(
    "/api/analysis-run/grouped-analysis",
    (req: Request, res: Response): any => {
      refreshConfigCache();
      const reportId =
        typeof req.query.reportId === "string" ? req.query.reportId : "";
      const runName =
        typeof req.query.runName === "string" ? req.query.runName : "";
      const content = req.body.content;
      if (!reportId || !runName)
        return res
          .status(400)
          .json({ error: "reportId and runName are required" });
      if (typeof content !== "string")
        return res.status(400).json({ error: "content is required" });
      try {
        const resolved = resolveGroupedAnalysisFile(reportId, runName);
        if (!resolved)
          return res.status(404).json({ error: "Grouped analysis file not found" });
        if (
          req.body.expectedVersion !== undefined &&
          contentVersion(fs.readFileSync(resolved, "utf8")) !==
          req.body.expectedVersion
        )
          return res
            .status(409)
            .json({ error: "This analysis changed. Reload before saving." });
        fs.writeFileSync(resolved, content, "utf-8");
        return res.json({ success: true });
      } catch (error: any) {
        console.error("Grouped analysis save error:", error.message);
        return res
          .status(500)
          .json({ error: "Failed to save grouped analysis file" });
      }
    }
  );

  // Agent vault endpoints
  app.get("/api/agent/vault/list", (req: Request, res: Response): any => {
    refreshConfigCache();
    try {
      const files: { filename: string; mtime: string }[] = [];
      if (appConfig.vaultPath && fs.existsSync(appConfig.vaultPath)) {
        const entries = fs.readdirSync(appConfig.vaultPath, {
          withFileTypes: true
        });
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith(".md")) {
            const filePath = path.join(appConfig.vaultPath, e.name);
            const stat = fs.statSync(filePath);
            files.push({
              filename: e.name.replace(/\.md$/, ""),
              mtime: stat.mtime.toISOString()
            });
          }
        }
      }
      if (appConfig.archivePath) {
        const analysisDir = path.join(appConfig.archivePath, "analysis");
        if (fs.existsSync(analysisDir)) {
          const entries = fs.readdirSync(analysisDir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isFile() && e.name.endsWith(".md")) {
              const filePath = path.join(analysisDir, e.name);
              const stat = fs.statSync(filePath);
              files.push({
                filename: e.name.replace(/\.md$/, ""),
                mtime: stat.mtime.toISOString()
              });
            }
          }
        }
      }
      return res.json({ schemaVersion: AGENT_API_SCHEMA_VERSION, files });
    } catch (error: any) {
      return res.status(500).json({ error: "Failed to list vault files" });
    }
  });

  app.get("/api/agent/vault/:filename", (req: Request, res: Response): any => {
    refreshConfigCache();
    const filename = req.params.filename as string;
    const resolved = resolveVaultFile(filename);
    if (!resolved) return res.status(404).json({ error: "Vault file not found" });
    try {
      const content = fs.readFileSync(resolved, "utf-8");
      res.type("text/markdown").send(content);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to read vault file" });
    }
  });
}

