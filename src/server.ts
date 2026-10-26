import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { registerAnalysisRoutes } from "./analysis-routes";
import { registerAriaRoutes } from "./aria-routes";
import { registerArtifactRoutes } from "./artifact-routes";
import {
  addPreset,
  AppConfig,
  deletePreset,
  getPresets,
  getReport,
  Preset,
  updateConfig
} from "./db";
import { registerDigestRoutes } from "./digest-routes";
import {
  ArtifactError
} from "./report-artifacts";
import { registerReportCatalog } from "./report-catalog";
import { registerReportRoutes } from "./report-routes";
import { assertReportInstance } from "./report-storage";
import { registerRunnerRoutes } from "./runner-routes";
import { activeDigests, activeFailureAnalyses, appConfig, refreshConfigCache, reportIsBusy } from "./runtime";
import { registerTrendsRoutes } from "./trends-routes";
import { registerTraceViewerRoutes } from "./trace-viewer-routes";
import { registerVaultRoutes } from "./vault-routes";

export const app = express();
const PORT = process.env.PORT || 9333;

// Enable CORS if you need to fetch from other origins
app.use(cors());

// Determine the correct public directory based on whether we are running from dist/ or src/
const publicDir = path.join(__dirname, "public");

// Serve the dashboard UI from the 'public' folder
app.use(express.static(publicDir));

// Enable JSON body parsing for our API
app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction): any => {
  const mutationPaths = [
    "/api/archive",
    "/api/delete",
    "/api/report-rename",
    "/api/extract",
    "/api/analysis-run/output-dir",
    "/api/analysis-run/analysis-file",
    "/api/digest",
    "/api/analysis-run/grouped-analysis",
    "/api/failures",
    "/api/digest-test",
    "/api/analysis/consolidate",
    "/api/report-metadata"
  ];
  if (req.method !== "GET" && mutationPaths.includes(req.path)) {
    const reportId =
      req.body?.reportId ||
      req.query.reportId ||
      (typeof req.body?.reportPath === "string"
        ? req.body.reportPath.split("/")[3]
        : undefined);
    const report =
      typeof reportId === "string" ? getReport(reportId) : undefined;
    if (report) {
      try {
        if (
          req.body?.reportUuid !== undefined &&
          req.body.reportUuid !== report.uuid
        )
          throw new ArtifactError("REPORT_CHANGED", "The report identity changed. Refresh before trying again.");
        if (["/api/archive", "/api/delete", "/api/report-rename", "/api/extract",
          "/api/failures", "/api/digest-test", "/api/report-metadata"].includes(req.path))
          assertReportInstance(report, req.body?.reportUuid, req.body?.reportPath);
      } catch (error) {
        console.warn("Report mutation rejected:", error);
        return res.status(409).json({
          code: error instanceof ArtifactError ? error.code : "REPORT_CHANGED",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      return res.status(404).json({ error: "Report not found. Refresh before trying again." });
    }
    if (report && reportIsBusy(report.uuid) &&
      !["/api/failures", "/api/digest-test", "/api/report-metadata"].includes(req.path))
      return res.status(409).json({
        code: "REPORT_ARTIFACTS_BUSY",
        error: "Wait for this report's analysis or digest to finish."
      });
  }
  if (
    req.method === "POST" &&
    req.path === "/api/config" &&
    (activeFailureAnalyses.size || activeDigests.size)
  ) {
    if (
      ["currentPath", "archivePath", "vaultPath"].some(
        (key) =>
          req.body?.[key] !== undefined &&
          req.body[key] !== appConfig[key as keyof AppConfig]
      )
    )
      return res.status(409).json({
        error:
          "Storage paths cannot change while analysis or digest jobs are running."
      });
  }
  next();
});

registerTraceViewerRoutes(app);

// Serve the reports dynamically using isolated mount points
app.use(
  "/reports/current",
  (req: Request, res: Response, next: NextFunction) => {
    if (appConfig.currentPath && fs.existsSync(appConfig.currentPath)) {
      express.static(appConfig.currentPath)(req, res, next);
    } else {
      next();
    }
  }
);

app.use(
  "/reports/archive",
  (req: Request, res: Response, next: NextFunction) => {
    if (appConfig.archivePath && fs.existsSync(appConfig.archivePath)) {
      express.static(appConfig.archivePath)(req, res, next);
    } else {
      next();
    }
  }
);

// Helper to validate a path
const validatePath = (dirPath: string): boolean => {
  if (!dirPath) return true; // Empty path is valid (clearing it)
  if (!fs.existsSync(dirPath))
    throw new Error(`Directory does not exist: ${dirPath}`);
  if (!fs.statSync(dirPath).isDirectory())
    throw new Error(`Path is not a directory: ${dirPath}`);
  return true;
};

// --- Config API Endpoints ---
app.get("/api/config", (req: Request, res: Response) => {
  refreshConfigCache();
  res.json(appConfig);
});

app.post("/api/config", (req: Request, res: Response): any => {
  const {
    currentPath,
    archivePath,
    projectPath,
    vaultPath,
    browserstackUsername,
    browserstackAccessKey,
    copilotToken,
    copilotModel,
    copilotBigModel,
    runnerOptions,
    selectedProjects
  } = req.body;

  try {
    if (currentPath !== undefined && currentPath !== null)
      validatePath(currentPath);
    if (archivePath !== undefined && archivePath !== null)
      validatePath(archivePath);
    if (projectPath !== undefined && projectPath !== null)
      validatePath(projectPath);
    if (vaultPath !== undefined && vaultPath !== null) validatePath(vaultPath);

    const newConfig: AppConfig = {
      id: "default",
      currentPath:
        currentPath !== undefined ? currentPath.trim() : appConfig.currentPath,
      archivePath:
        archivePath !== undefined ? archivePath.trim() : appConfig.archivePath,
      projectPath:
        projectPath !== undefined ? projectPath.trim() : appConfig.projectPath,
      vaultPath:
        vaultPath !== undefined ? vaultPath.trim() : appConfig.vaultPath,
      browserstackUsername:
        browserstackUsername !== undefined
          ? browserstackUsername.trim()
          : appConfig.browserstackUsername,
      browserstackAccessKey:
        browserstackAccessKey !== undefined
          ? browserstackAccessKey.trim()
          : appConfig.browserstackAccessKey,
      copilotToken:
        copilotToken !== undefined
          ? copilotToken.trim()
          : appConfig.copilotToken,
      copilotModel:
        copilotModel !== undefined
          ? copilotModel.trim()
          : appConfig.copilotModel,
      copilotBigModel:
        copilotBigModel !== undefined
          ? copilotBigModel.trim()
          : appConfig.copilotBigModel,
      runnerOptions:
        runnerOptions !== undefined
          ? { ...appConfig.runnerOptions, ...runnerOptions }
          : appConfig.runnerOptions,
      selectedProjects:
        selectedProjects !== undefined && Array.isArray(selectedProjects)
          ? selectedProjects
          : appConfig.selectedProjects
    };

    updateConfig(newConfig);
    refreshConfigCache();
    res.json({ success: true, config: appConfig });
  } catch (error: any) {
    console.error("Validation/Save error:", error.message);
    res.status(400).json({ error: error.message });
  }
});

// --- Presets API Endpoints ---
app.get("/api/presets", (req: Request, res: Response) => {
  const presets = getPresets();
  res.json({ success: true, presets });
});

app.post("/api/presets", (req: Request, res: Response): any => {
  const { name, projects } = req.body;
  if (!name || typeof name !== "string")
    return res.status(400).json({ error: "Preset name is required" });
  if (!Array.isArray(projects))
    return res.status(400).json({ error: "projects must be an array" });

  try {
    const newPreset: Preset = {
      id: Date.now().toString(),
      configId: "default",
      name: name.trim(),
      projects: projects
    };
    addPreset(newPreset);
    res.json({ success: true, preset: newPreset });
  } catch (error: any) {
    console.error("Save preset error:", error.message);
    res.status(500).json({ error: "Failed to save preset" });
  }
});

app.delete("/api/presets/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    deletePreset(id as string);
    res.json({ success: true });
  } catch (error: any) {
    console.error("Delete preset error:", error.message);
    res.status(500).json({ error: "Failed to delete preset" });
  }
});

registerReportCatalog(app);
registerRunnerRoutes(app);
registerAnalysisRoutes(app);
registerDigestRoutes(app);
registerReportRoutes(app);
registerAriaRoutes(app);
registerArtifactRoutes(app);
registerVaultRoutes(app);
registerTrendsRoutes(app);

app.use("/api", (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.path}` });
});

// Fallback to dashboard for any missing routes
app.use((req: Request, res: Response) => {
  if (req.path.startsWith("/runner")) {
    res.sendFile(path.join(publicDir, "runner.html"));
  } else {
    res.sendFile(path.join(publicDir, "index.html"));
  }
});

if (require.main === module)
  app.listen(PORT, () => {
    console.log(
      `🚀 Playwright Report Viewer is running on http://localhost:${PORT}`
    );
  });
