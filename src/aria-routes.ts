import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { readReportArchive } from "./report-archive";
import { assertOwnedPath, ArtifactError } from "./report-artifacts";
import { loadPlaywrightConfigProjection } from "./playwright-config-loader";
import {
  discoverRunnerConfigs,
  resolveDiscoveredConfig
} from "./runner-configs";
import { appConfig, refreshConfigCache } from "./runtime";

export function registerAriaRoutes(app: Express): void {

  // Aria Snapshot Extraction Endpoint
  app.post(
    "/api/aria-snapshots",
    async (req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      const { reportPath } = req.body;

      if (typeof reportPath !== "string" || !reportPath)
        return res.status(400).json({ error: "reportPath is required" });
      if (!appConfig.projectPath)
        return res.status(400).json({ error: "Project path is not configured" });

      let ariaSnapshotPathTemplate: string | undefined;
      try {
        const { playwrightConfigs } = await discoverRunnerConfigs(
          appConfig.projectPath
        );
        const selectedConfig = playwrightConfigs.includes(
          appConfig.runnerOptions.playwrightConfig
        )
          ? appConfig.runnerOptions.playwrightConfig
          : playwrightConfigs[0];
        if (selectedConfig) {
          const configPath = resolveDiscoveredConfig(
            appConfig.projectPath,
            selectedConfig,
            playwrightConfigs,
            "Playwright config"
          );
          const projection = await loadPlaywrightConfigProjection(configPath, {
            cwd: appConfig.projectPath
          });
          ariaSnapshotPathTemplate = projection.ariaSnapshotPathTemplate;
        }
      } catch (e) {
        console.error("Failed to load playwright config for aria snapshots:", e);
        return res.status(400).json({ error: `Could not load the snapshot configuration: ${String(e)}` });
      }

      try {
        const isArchive = reportPath.startsWith("/reports/archive/");
        const basePath = isArchive
          ? appConfig.archivePath
          : appConfig.currentPath;
        if (!basePath)
          return res.status(400).json({ error: "Base directory not configured" });

        const urlParts = reportPath.split("/");
        if (urlParts.length < 4)
          return res.status(400).json({ error: "Invalid report path format" });
        const folderName = urlParts[3];
        const physicalFolder = path.join(basePath, folderName);
        const indexPath = path.join(physicalFolder, "index.html");

        if (!fs.existsSync(indexPath))
          return res.status(404).json({ error: "Report index.html not found" });

        const indexHtml = fs.readFileSync(indexPath, "utf8");
        const zip = readReportArchive(indexHtml);
        const zipEntries = zip.getEntries();

        const ariaFailures: any[] = [];

        for (const entry of zipEntries) {
          if (
            !entry.entryName.endsWith(".json") ||
            entry.entryName === "report.json"
          )
            continue;

          const content = Buffer.from(entry.getData()).toString("utf8");
          const data = JSON.parse(content);
          if (!data.tests) continue;

          for (const test of data.tests) {
            if (!test.results) continue;

            let foundErrors = false;
            const snapshotsToFix: {
              expectedPath: string;
              expectedSnapshot?: string;
              newSnapshot: string;
            }[] = [];

            for (const result of test.results) {
              for (const err of result.errors || []) {
                const errorMsg = typeof err === "string" ? err : err.message;
                const codeframe = typeof err === "object" ? err.codeframe : "";

                if (errorMsg && errorMsg.includes("toMatchAriaSnapshot")) {
                  // Extract filename from codeframe or message
                  let expectedFilename = "";
                  const nameRegex = /name:\s*['"]([^'"]+\.ya?ml)['"]/;

                  if (codeframe) {
                    const codeLines = codeframe.split("\n");
                    const errorLineIdx = codeLines.findIndex(
                      (l: string) => l.includes("^ Error:") || l.startsWith(">")
                    );
                    if (errorLineIdx > -1) {
                      const searchScope = codeLines
                        .slice(Math.max(0, errorLineIdx - 2), errorLineIdx + 5)
                        .join("\n");
                      const match = searchScope.match(nameRegex);
                      if (match) expectedFilename = match[1];
                    } else {
                      const matches = [
                        ...codeframe.matchAll(new RegExp(nameRegex.source, "g"))
                      ];
                      if (matches.length > 0)
                        expectedFilename = matches[matches.length - 1][1];
                    }
                  }

                  if (!expectedFilename) {
                    const matchMsg = errorMsg.match(nameRegex);
                    if (matchMsg) expectedFilename = matchMsg[1];
                  }

                  // Clean ANSI
                  const stripAnsi = (str: string) =>
                    str.replace(/\x1B\[[0-9;]*m/g, "");
                  const cleanMsg = stripAnsi(errorMsg);

                  let newSnapshot = "";
                  const unexpectedValueToken = '- unexpected value "';
                  const unexpectedValueIdx =
                    cleanMsg.lastIndexOf(unexpectedValueToken);

                  if (unexpectedValueIdx !== -1) {
                    const snapshotStart =
                      unexpectedValueIdx + unexpectedValueToken.length;
                    const remaining = cleanMsg.substring(snapshotStart);
                    const lines = remaining.split("\n");
                    const extractedLines = [];
                    let foundEnd = false;
                    for (let i = 0;i < lines.length;i++) {
                      let line = lines[i].replace(/\r/g, "");
                      if (i === 0 && line.startsWith("- ")) {
                        extractedLines.push(line);
                      } else if (!foundEnd) {
                        if (
                          line.endsWith('"') &&
                          (i === lines.length - 1 ||
                            lines[i + 1].trim() === "" ||
                            /^\s*\d+ × locator resolved/.test(lines[i + 1]))
                        ) {
                          foundEnd = true;
                          extractedLines.push(line.substring(0, line.length - 1));
                        } else {
                          extractedLines.push(line);
                        }
                      }
                    }
                    newSnapshot = extractedLines.join("\n");
                  } else {
                    // Fallback to old diff string extraction if it does not have the 'unexpected value' Call log (e.g. older playwright versions)
                    const diffStart = cleanMsg.indexOf("@@");
                    const diffEnd = cleanMsg.indexOf("Call log:");
                    if (diffStart !== -1) {
                      const diffString = cleanMsg
                        .substring(
                          diffStart,
                          diffEnd > -1 ? diffEnd : cleanMsg.length
                        )
                        .trim();
                      const lines = diffString.split("\n");
                      const newSnapshotLines = [];
                      let inDiff = false;
                      for (let line of lines) {
                        line = line.replace(/\r/g, "");
                        if (line === "Call log:") break;
                        if (!inDiff) {
                          if (
                            line.startsWith("- Expected") ||
                            line.startsWith("+ Received") ||
                            line.trim() === "" ||
                            line.startsWith("Error:") ||
                            line.startsWith("Locator:") ||
                            line.startsWith("Timeout:")
                          ) {
                            continue;
                          }
                          if (
                            line.startsWith("@@ ") ||
                            line.startsWith("- ") ||
                            line.startsWith("+ ") ||
                            line.startsWith("  ")
                          ) {
                            inDiff = true;
                          }
                        }
                        if (inDiff) {
                          if (line.startsWith("@@ ")) continue;
                          if (line.startsWith("+") || line.startsWith(" ")) {
                            newSnapshotLines.push(line.substring(1));
                          }
                        }
                      }
                      newSnapshot = newSnapshotLines.join("\n");
                    }
                  }

                  // Note: Content-based matching against the expected snapshot still requires knowing the expected snapshot.
                  // Playwright doesn't print the *entire* expected file if it's too long in the diff,
                  // but we don't necessarily need the expected string anymore because codeframe filename extraction works perfectly.
                  // I will keep the existing expected string extraction around for the fallback content matching if codeframe fails.
                  let expectedSnapshot = "";
                  const diffStart = cleanMsg.indexOf("@@");
                  const diffEnd = cleanMsg.indexOf("Call log:");
                  if (diffStart !== -1) {
                    const diffString = cleanMsg
                      .substring(
                        diffStart,
                        diffEnd > -1 ? diffEnd : cleanMsg.length
                      )
                      .trim();
                    const lines = diffString.split("\n");
                    const expectedLines = [];
                    let inDiff = false;
                    for (let line of lines) {
                      line = line.replace(/\r/g, "");
                      if (line === "Call log:") break;
                      if (!inDiff) {
                        if (
                          line.startsWith("- Expected") ||
                          line.startsWith("+ Received") ||
                          line.trim() === "" ||
                          line.startsWith("Error:") ||
                          line.startsWith("Locator:") ||
                          line.startsWith("Timeout:")
                        ) {
                          continue;
                        }
                        if (
                          line.startsWith("@@ ") ||
                          line.startsWith("- ") ||
                          line.startsWith("+ ") ||
                          line.startsWith("  ")
                        ) {
                          inDiff = true;
                        }
                      }
                      if (inDiff) {
                        if (line.startsWith("@@ ")) continue;
                        if (line.startsWith("-") || line.startsWith(" ")) {
                          expectedLines.push(line.substring(1));
                        }
                      }
                    }
                    expectedSnapshot = expectedLines.join("\n");
                  }

                  // Determine aria snapshots directory
                  let testAriaDir = `src/test-data/aria-snapshots/${test.location.file}`;
                  if (ariaSnapshotPathTemplate) {
                    const template = ariaSnapshotPathTemplate;
                    const parsedRelPath = path.parse(test.location.file);
                    let resolvedDirTemplate = template
                      .replace(/\{(.)?testFilePath\}/g, test.location.file)
                      .replace(/\{(.)?testFileName\}/g, parsedRelPath.base)
                      .replace(/\{(.)?testFileDir\}/g, parsedRelPath.dir);
                    testAriaDir = resolvedDirTemplate.substring(
                      0,
                      resolvedDirTemplate.lastIndexOf("/")
                    );
                  }

                  let expectedPath = expectedFilename
                    ? path.join(testAriaDir, expectedFilename)
                    : "";

                  // Content-based matching logic
                  const isContentMatch = (
                    filePath: string,
                    expectedContentStr: string
                  ) => {
                    try {
                      const content = fs.readFileSync(
                        path.join(appConfig.projectPath!, filePath),
                        "utf8"
                      );
                      // Use a softer trim since aria snapshots often have specific whitespace but trailing space can differ
                      return content.trim() === expectedContentStr.trim();
                    } catch (e) {
                      return false;
                    }
                  };

                  let foundPath = "";
                  if (
                    expectedPath &&
                    isContentMatch(expectedPath, expectedSnapshot)
                  ) {
                    foundPath = expectedPath;
                  } else {
                    const absoluteAriaDir = path.join(
                      appConfig.projectPath!,
                      testAriaDir
                    );
                    if (fs.existsSync(absoluteAriaDir)) {
                      const files = fs.readdirSync(absoluteAriaDir);
                      for (const file of files) {
                        if (!file.endsWith(".yml")) continue;
                        const maybePath = path.join(testAriaDir, file);
                        if (isContentMatch(maybePath, expectedSnapshot)) {
                          foundPath = maybePath;
                          break;
                        }
                      }
                    }
                  }
                  if (foundPath) {
                    expectedPath = foundPath;
                  } else if (!expectedPath) {
                    expectedPath = "UNRESOLVED_PATH.yml";
                  }

                  let expectedSnapshotText = "";
                  if (expectedPath && expectedPath !== "UNRESOLVED_PATH.yml") {
                    try {
                      expectedSnapshotText = fs
                        .readFileSync(
                          path.join(appConfig.projectPath!, expectedPath),
                          "utf8"
                        )
                        .replace(/\r\n/g, "\n")
                        .replace(/\r/g, "\n");
                    } catch (e) {
                      console.error(
                        "Failed to read expected snapshot from disk",
                        e
                      );
                    }
                  }

                  if (
                    !snapshotsToFix.some((s) => s.newSnapshot === newSnapshot)
                  ) {
                    snapshotsToFix.push({
                      expectedPath,
                      expectedSnapshot: expectedSnapshotText,
                      newSnapshot
                    });
                  }
                  foundErrors = true;
                }
              }
            }

            if (foundErrors && snapshotsToFix.length > 0) {
              ariaFailures.push({
                testId: test.testId,
                testTitle: test.title,
                projectName: test.projectName,
                file: test.location.file,
                snapshots: snapshotsToFix
              });
            }
          }
        }

        res.json({ success: true, ariaFailures });
      } catch (error: any) {
        console.error("Aria snapshots error:", error);
        res
          .status(500)
          .json({ error: "Failed to extract aria snapshots: " + error.message });
      }
    }
  );

  // Aria Snapshot Fixing Endpoint
  app.post("/api/fix-aria-snapshot", (req: Request, res: Response): any => {
    const { snapshotPath, newContent } = req.body;

    if (typeof snapshotPath !== "string" || !snapshotPath || typeof newContent !== "string") {
      return res
        .status(400)
        .json({ error: "snapshotPath and newContent are required." });
    }

    if (!appConfig.projectPath) {
      return res.status(400).json({ error: "Project path is not configured" });
    }

    try {
      if (snapshotPath === "UNRESOLVED_PATH.yml")
        return res.status(400).json({ error: "The snapshot path could not be resolved. Review the assertion and configuration first." });
      const absolutePath = path.resolve(appConfig.projectPath, snapshotPath);
      assertOwnedPath(appConfig.projectPath, absolutePath);

      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

      fs.writeFileSync(absolutePath, newContent, "utf8");
      res.json({ success: true, message: "Aria snapshot updated successfully." });
    } catch (error: any) {
      console.error("Failed to fix aria snapshot:", error);
      res
        .status(error instanceof ArtifactError ? 403 : 500)
        .json({ error: "Failed to update aria snapshot: " + error.message });
    }
  });
}
