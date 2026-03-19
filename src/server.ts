import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { AppConfig, Preset, getConfig, updateConfig, getPresets, addPreset, deletePreset, ReportRecord, upsertReport, getReport, getAllReports, updateReportMetadata, deleteReportRecord, updateReportId } from './db';
import { spawn, ChildProcess } from 'child_process';
import { createJiti } from 'jiti';
import treeKill from 'tree-kill';

const jiti = createJiti(__filename, { moduleCache: false });

const app = express();
const PORT = process.env.PORT || 9333;

// Enable CORS if you need to fetch from other origins
app.use(cors());

// Determine the correct public directory based on whether we are running from dist/ or src/
const isBuild = __dirname.endsWith('dist');
const publicDir = isBuild ? path.join(__dirname, 'public') : path.join(__dirname, 'public');

// Serve the dashboard UI from the 'public' folder
app.use(express.static(publicDir));

// Global AppConfig cache for fast synchronous access in middlewares
let appConfig: AppConfig = getConfig();

const refreshConfigCache = () => {
  appConfig = getConfig();
};

// Enable JSON body parsing for our API
app.use(express.json());

// Serve the reports dynamically using isolated mount points
app.use('/reports/current', (req: Request, res: Response, next: NextFunction) => {
  if (appConfig.currentPath && fs.existsSync(appConfig.currentPath)) {
    express.static(appConfig.currentPath)(req, res, next);
  } else {
    next();
  }
});

app.use('/reports/archive', (req: Request, res: Response, next: NextFunction) => {
  if (appConfig.archivePath && fs.existsSync(appConfig.archivePath)) {
    express.static(appConfig.archivePath)(req, res, next);
  } else {
    next();
  }
});

// Helper to validate a path
const validatePath = (dirPath: string): boolean => {
  if (!dirPath) return true; // Empty path is valid (clearing it)
  if (!fs.existsSync(dirPath)) throw new Error(`Directory does not exist: ${dirPath}`);
  if (!fs.statSync(dirPath).isDirectory()) throw new Error(`Path is not a directory: ${dirPath}`);
  return true;
};

// --- Config API Endpoints ---
app.get('/api/config', (req: Request, res: Response) => {
  refreshConfigCache();
  res.json(appConfig);
});

app.post('/api/config', (req: Request, res: Response): any => {
  const { currentPath, archivePath, projectPath, runnerOptions, selectedProjects } = req.body;
  
  try {
    if (currentPath !== undefined && currentPath !== null) validatePath(currentPath);
    if (archivePath !== undefined && archivePath !== null) validatePath(archivePath);
    if (projectPath !== undefined && projectPath !== null) validatePath(projectPath);

    const newConfig: AppConfig = {
      id: 'default',
      currentPath: currentPath !== undefined ? currentPath.trim() : appConfig.currentPath,
      archivePath: archivePath !== undefined ? archivePath.trim() : appConfig.archivePath,
      projectPath: projectPath !== undefined ? projectPath.trim() : appConfig.projectPath,
      runnerOptions: runnerOptions !== undefined ? { ...appConfig.runnerOptions, ...runnerOptions } : appConfig.runnerOptions,
      selectedProjects: selectedProjects !== undefined && Array.isArray(selectedProjects) ? selectedProjects : appConfig.selectedProjects
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
app.get('/api/presets', (req: Request, res: Response) => {
  const presets = getPresets();
  res.json({ success: true, presets });
});

app.post('/api/presets', (req: Request, res: Response): any => {
    const { name, projects } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: "Preset name is required" });
    if (!Array.isArray(projects)) return res.status(400).json({ error: "projects must be an array" });

    try {
        const newPreset: Preset = {
            id: Date.now().toString(),
            configId: 'default',
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

app.delete('/api/presets/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        deletePreset(id as string);
        res.json({ success: true });
    } catch (error: any) {
        console.error("Delete preset error:", error.message);
        res.status(500).json({ error: "Failed to delete preset" });
    }
});

interface ReportInfo {
  id: string;
  name: string;
  path: string;
  createdAt: Date;
  modifiedAt: Date;
  metadata: string;
}

// Helper to scan a directory for valid reports and sync with DB
const scanDirectory = (dirPath: string, prefix: string): ReportInfo[] => {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    console.error("Could not read directory:", dirPath);
    return [];
  }
  
  const reports = entries
    .filter(dirent => dirent.isDirectory())
    .map(dirent => {
      const folderPath = path.join(dirPath, dirent.name);
      
      try {
          const stat = fs.statSync(folderPath);
          
          // Check if index.html exists in this folder to confirm it's a valid report
          const indexPath = path.join(folderPath, 'index.html');
          const hasIndex = fs.existsSync(indexPath);
          if (!hasIndex) return null;

          // Deep inspection: verify it's actually a Playwright report
          const indexContent = fs.readFileSync(indexPath, 'utf8');
          if (!indexContent.includes('<title>Playwright Test Report</title>')) return null;

          const reportPath = `/reports/${prefix}/${dirent.name}/index.html`;

          // Look up existing DB record to preserve metadata
          const existing = getReport(dirent.name);
          const metadata = existing?.metadata || '';

          // Upsert into DB (preserves metadata via ON CONFLICT)
          upsertReport({
            id: dirent.name,
            dateCreated: stat.birthtime.toISOString(),
            metadata,
            reportPath
          });

          return {
            id: dirent.name,
            name: dirent.name,
            path: reportPath,
            createdAt: stat.birthtime,
            modifiedAt: stat.mtime,
            metadata
          };
      } catch (err) {
          // If permission denied or other read error, skip safely
          return null;
      }
    })
    .filter((item): item is ReportInfo => item !== null)
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  // Clean up stale DB entries: remove records for reports no longer on disk
  const diskIds = new Set(reports.map(r => r.id));
  const allDbReports = getAllReports();
  for (const dbReport of allDbReports) {
    // Only clean up records that belong to this prefix (check reportPath)
    if (dbReport.reportPath.startsWith(`/reports/${prefix}/`) && !diskIds.has(dbReport.id)) {
      deleteReportRecord(dbReport.id);
    }
  }

  return reports;
};

// API Endpoint to get the list of available reports
app.get('/api/reports', (req, res) => {
  res.json({
    current: appConfig.currentPath ? scanDirectory(appConfig.currentPath, 'current') : [],
    archive: appConfig.archivePath ? scanDirectory(appConfig.archivePath, 'archive') : [],
    configStatus: {
      hasCurrent: !!appConfig.currentPath,
      hasArchive: !!appConfig.archivePath,
      hasProject: !!appConfig.projectPath
    }
  });
});

// Test Runner Integrations
app.get('/api/projects', (req: Request, res: Response): any => {
  if (!appConfig.projectPath || !fs.existsSync(appConfig.projectPath)) {
    return res.json({ projects: [] });
  }

  try {
    const configTs = path.join(appConfig.projectPath, 'playwright.config.ts');
    const configJs = path.join(appConfig.projectPath, 'playwright.config.js');

    let configPath = '';
    if (fs.existsSync(configTs)) configPath = configTs;
    else if (fs.existsSync(configJs)) configPath = configJs;
    else return res.json({ projects: [] });

    // Clear cache by deleting require.cache is not needed for jiti usually with moduleCache false
    const config = jiti(configPath);
    const cfg = config.default || config;

    if (cfg.projects && Array.isArray(cfg.projects)) {
      const projects = cfg.projects.map((p: any) => p.name).filter(Boolean);
      return res.json({ projects });
    }
    return res.json({ projects: [] });
  } catch (error) {
    console.error('Error parsing config:', error);
    return res.json({ projects: [] });
  }
});

let activeProcess: ChildProcess | null = null;
let sseClients: Response[] = [];

const broadcastLog = (type: string, data: string) => {
  sseClients.forEach(client => {
    client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  });
};

app.get('/api/logs', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  sseClients.push(res);
  
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

const stopTests = (): Promise<void> => {
  return new Promise((resolve) => {
    if (activeProcess && activeProcess.pid) {
      treeKill(activeProcess.pid, 'SIGKILL', () => {
        activeProcess = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
};

app.post('/api/stop-tests', async (req: Request, res: Response) => {
  await stopTests();
  broadcastLog('output', '\nTests stopped by user.\n');
  res.json({ success: true });
});

app.post('/api/run-tests', async (req: Request, res: Response): Promise<any> => {
  if (activeProcess) {
    await stopTests();
  }

  const { args = [], env = {} } = req.body;
  if (!appConfig.projectPath) {
    return res.status(400).json({ error: "Project path is not configured" });
  }

  const customEnv = { ...process.env, FORCE_COLOR: '1', ...env };
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';

  try {
    const child = spawn(command, ['playwright', 'test', ...args], {
      cwd: appConfig.projectPath,
      env: customEnv,
      shell: process.platform === 'win32' // On Windows we usually need shell for npx
    });

    activeProcess = child;
    broadcastLog('start', `Running npx playwright test ${args.join(' ')}\n`);

    child.stdout?.on('data', (data) => broadcastLog('output', data.toString()));
    child.stderr?.on('data', (data) => broadcastLog('output', data.toString()));

    child.on('close', (code) => {
      broadcastLog('output', `\nProcess exited with code ${code}\n`);
      broadcastLog('complete', code?.toString() || '0');
      if (activeProcess === child) activeProcess = null;
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Auto-extract traces endpoint
app.post('/api/extract', (req: Request, res: Response): any => {
  const { reportPath } = req.body;
  if (!reportPath) return res.status(400).json({ error: "reportPath is required" });

  try {
    // 1. Determine which base directory this is from (current vs archive)
    const isArchive = reportPath.startsWith('/reports/archive/');
    const basePath = isArchive ? appConfig.archivePath : appConfig.currentPath;
    
    if (!basePath) {
      return res.status(400).json({ error: "Base directory not configured" });
    }

    // 2. Extract the actual report folder name from the URL path
    // e.g., /reports/current/my-test-run/index.html -> my-test-run
    const urlParts = reportPath.split('/');
    if (urlParts.length < 4) return res.status(400).json({ error: "Invalid report path format" });
    
    const folderName = urlParts[3]; 

    // 3. Construct the absolute physical path to the report's data folder
    const physicalDataFolder = path.join(basePath, folderName, 'data');
    
    if (!fs.existsSync(physicalDataFolder)) {
      return res.json({ success: true, extractedCount: 0, message: "No data folder found, nothing to extract." });
    }

    // 4. Scan the data folder for .zip files
    let extractedCount = 0;
    const entries = fs.readdirSync(physicalDataFolder, { withFileTypes: true });
    
    for (const dirent of entries) {
      if (dirent.isFile() && dirent.name.endsWith('.zip')) {
        const zipFile = path.join(physicalDataFolder, dirent.name);
        
        // Target extraction folder: drop the '.zip' extension
        const targetFolderName = dirent.name.replace('.zip', '');
        const targetExtractionPath = path.join(physicalDataFolder, targetFolderName);
        
        // Idempotency check: Skip if the unzipped folder already exists!
        if (fs.existsSync(targetExtractionPath)) {
          continue; 
        }

        // Lazy load AdmZip only when actually extracting to save memory globally
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipFile);
        
        // Extract everything into the newly named folder
        zip.extractAllTo(targetExtractionPath, true); // true = overwrite
        extractedCount++;
      }
    }

    res.json({ success: true, extractedCount });
    
  } catch (error: any) {
    console.error("Extraction error:", error);
    res.status(500).json({ error: "Failed to extract trace files: " + error.message });
  }
});

// Auto-archive report endpoint
app.post('/api/archive', (req: Request, res: Response): any => {
  const { reportPath } = req.body;
  
  if (!reportPath) return res.status(400).json({ error: "reportPath is required" });
  if (!appConfig.archivePath) return res.status(400).json({ error: "Archive directory is not configured! Please open Preferences and set an archive path first." });

  try {
    // Determine source directory
    const isArchive = reportPath.startsWith('/reports/archive/');
    if (isArchive) return res.status(400).json({ error: "Report is already in the archive" });
    
    if (!appConfig.currentPath) return res.status(400).json({ error: "Current directory not configured" });

    // Extract the actual report folder name from the URL path
    const urlParts = reportPath.split('/');
    if (urlParts.length < 4) return res.status(400).json({ error: "Invalid report path format" });
    
    const folderName = urlParts[3]; 

    // Construct the absolute physical source path
    const sourcePhysicalFolder = path.join(appConfig.currentPath, folderName);
    
    if (!fs.existsSync(sourcePhysicalFolder)) {
      return res.status(404).json({ error: "Report folder not found on disk" });
    }

    // Construct unique destination physical path
    const uniqueArchivedName = `playwright-report-${Date.now()}`;
    const destinationPhysicalFolder = path.join(appConfig.archivePath, uniqueArchivedName);

    try {
      // Fast path: same drive move
      fs.renameSync(sourcePhysicalFolder, destinationPhysicalFolder);
    } catch (renameErr: any) {
      if (renameErr.code === 'EXDEV') {
        // Slow path: cross drive move (copy then delete)
        fs.cpSync(sourcePhysicalFolder, destinationPhysicalFolder, { recursive: true });
        fs.rmSync(sourcePhysicalFolder, { recursive: true, force: true });
      } else {
        throw renameErr; // Bubble up other I/O errors
      }
    }

    // Update DB record: transfer from old folder name to new archived folder name
    const newReportPath = `/reports/archive/${uniqueArchivedName}/index.html`;
    updateReportId(folderName, uniqueArchivedName, newReportPath);

    res.json({ success: true, newName: uniqueArchivedName });
    
  } catch (error: any) {
    console.error("Archive error:", error);
    res.status(500).json({ error: "Failed to archive report: " + error.message });
  }
});

// Auto-delete report endpoint
app.post('/api/delete', (req: Request, res: Response): any => {
  const { reportPath } = req.body;
  if (!reportPath) return res.status(400).json({ error: "reportPath is required" });

  try {
    // Determine which base directory this is from (current vs archive)
    const isArchive = reportPath.startsWith('/reports/archive/');
    const basePath = isArchive ? appConfig.archivePath : appConfig.currentPath;
    
    if (!basePath) {
      return res.status(400).json({ error: "Base directory not configured" });
    }

    // Extract the actual report folder name from the URL path
    const urlParts = reportPath.split('/');
    if (urlParts.length < 4) return res.status(400).json({ error: "Invalid report path format" });
    
    const folderName = urlParts[3]; 

    // Construct the absolute physical path to the report folder
    const targetPhysicalFolder = path.join(basePath, folderName);
    
    if (!fs.existsSync(targetPhysicalFolder)) {
      return res.status(404).json({ error: "Report folder not found on disk" });
    }

    // Delete the directory and its contents
    fs.rmSync(targetPhysicalFolder, { recursive: true, force: true });

    // Remove DB record
    deleteReportRecord(folderName);

    res.json({ success: true });
    
  } catch (error: any) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Failed to delete report: " + error.message });
  }
});

// Update report metadata endpoint
app.post('/api/report-metadata', (req: Request, res: Response): any => {
  const { reportId, metadata } = req.body;
  if (!reportId) return res.status(400).json({ error: "reportId is required" });
  if (metadata === undefined) return res.status(400).json({ error: "metadata is required" });

  try {
    const existing = getReport(reportId);
    if (!existing) return res.status(404).json({ error: "Report not found in database" });

    updateReportMetadata(reportId, metadata);
    res.json({ success: true });
  } catch (error: any) {
    console.error("Metadata update error:", error);
    res.status(500).json({ error: "Failed to update metadata: " + error.message });
  }
});

// Rename report endpoint (renames folder on disk + updates DB id/path)
app.post('/api/report-rename', (req: Request, res: Response): any => {
  const { reportId, newName } = req.body;
  if (!reportId) return res.status(400).json({ error: "reportId is required" });
  if (!newName || typeof newName !== 'string') return res.status(400).json({ error: "newName is required" });

  const trimmed = newName.trim();
  if (!trimmed) return res.status(400).json({ error: "newName cannot be empty" });
  if (/[/\\:*?"<>|\x00]/.test(trimmed)) return res.status(400).json({ error: "newName contains invalid characters" });
  if (trimmed === '.' || trimmed === '..') return res.status(400).json({ error: "newName is not a valid folder name" });

  try {
    const existing = getReport(reportId);
    if (!existing) return res.status(404).json({ error: "Report not found in database" });
    if (!existing.reportPath.startsWith('/reports/current/')) return res.status(400).json({ error: "Only current reports can be renamed" });
    if (!appConfig.currentPath) return res.status(400).json({ error: "Current directory is not configured" });

    const oldFolder = path.resolve(appConfig.currentPath, reportId);
    const newFolder = path.resolve(appConfig.currentPath, trimmed);

    // Path traversal guard
    const base = path.resolve(appConfig.currentPath);
    if (!oldFolder.startsWith(base + path.sep) && oldFolder !== base) return res.status(400).json({ error: "Invalid report path" });
    if (!newFolder.startsWith(base + path.sep) && newFolder !== base) return res.status(400).json({ error: "Invalid new name" });

    if (!fs.existsSync(oldFolder)) return res.status(404).json({ error: "Report folder not found on disk" });
    if (fs.existsSync(newFolder)) return res.status(409).json({ error: `A report named "${trimmed}" already exists` });

    fs.renameSync(oldFolder, newFolder);
    const newReportPath = `/reports/current/${trimmed}/index.html`;
    updateReportId(reportId, trimmed, newReportPath);

    res.json({ success: true, newId: trimmed, newPath: newReportPath });
  } catch (error: any) {
    console.error("Rename error:", error);
    res.status(500).json({ error: "Failed to rename report: " + error.message });
  }
});

// Aria Snapshot Extraction Endpoint
app.post('/api/aria-snapshots', (req: Request, res: Response): any => {
  const { reportPath } = req.body;
  
  if (!reportPath) return res.status(400).json({ error: "reportPath is required" });
  if (!appConfig.projectPath) return res.status(400).json({ error: "Project path is not configured" });

  try {
    const isArchive = reportPath.startsWith('/reports/archive/');
    const basePath = isArchive ? appConfig.archivePath : appConfig.currentPath;
    if (!basePath) return res.status(400).json({ error: "Base directory not configured" });

    const urlParts = reportPath.split('/');
    if (urlParts.length < 4) return res.status(400).json({ error: "Invalid report path format" });
    const folderName = urlParts[3]; 
    const physicalFolder = path.join(basePath, folderName);
    const indexPath = path.join(physicalFolder, 'index.html');

    if (!fs.existsSync(indexPath)) return res.status(404).json({ error: "Report index.html not found" });
    
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    let base64Data = "";
    
    // Check old format window.playwrightReportBase64
    const zipMatch = indexHtml.match(/window\.playwrightReportBase64\s*=\s*"([^"]+)"/);
    if (zipMatch) {
        base64Data = zipMatch[1];
    } else {
        // Check new format <script id="playwrightReportBase64" type="application/zip">data:application/zip;base64,...</script>
        const scriptMatch = indexHtml.match(/<script id="playwrightReportBase64"[^>]*>data:application\/zip;base64,([^<]+)<\/script>/);
        if (scriptMatch) {
            base64Data = scriptMatch[1];
        }
    }
    
    if (!base64Data) return res.status(400).json({ error: "Could not find embedded report data in index.html" });
    
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(Buffer.from(base64Data, 'base64'));
    const zipEntries = zip.getEntries();
    
    const ariaFailures: any[] = [];
    
    for (const entry of zipEntries) {
      if (!entry.entryName.endsWith('.json') || entry.entryName === 'report.json') continue;
      
      const content = Buffer.from(entry.getData()).toString('utf8');
      const data = JSON.parse(content);
      if (!data.tests) continue;
      
      for (const test of data.tests) {
        if (!test.results) continue;
        
        let foundErrors = false;
        const snapshotsToFix: { expectedPath: string, expectedSnapshot?: string, newSnapshot: string }[] = [];
        
        for (const result of test.results) {
          for (const err of result.errors || []) {
            const errorMsg = typeof err === 'string' ? err : err.message;
            const codeframe = typeof err === 'object' ? err.codeframe : '';
            
            if (errorMsg && errorMsg.includes('toMatchAriaSnapshot')) {
                // Extract filename from codeframe or message
                let expectedFilename = '';
                const nameRegex = /name:\s*['"]([^'"]+\.ya?ml)['"]/;
                
                if (codeframe) {
                    const codeLines = codeframe.split('\n');
                    const errorLineIdx = codeLines.findIndex((l: string) => l.includes('^ Error:') || l.startsWith('>'));
                    if (errorLineIdx > -1) {
                        const searchScope = codeLines.slice(Math.max(0, errorLineIdx - 2), errorLineIdx + 5).join('\n');
                        const match = searchScope.match(nameRegex);
                        if (match) expectedFilename = match[1];
                    } else {
                        const matches = [...codeframe.matchAll(new RegExp(nameRegex.source, 'g'))];
                        if (matches.length > 0) expectedFilename = matches[matches.length - 1][1];
                    }
                }
                
                if (!expectedFilename) {
                    const matchMsg = errorMsg.match(nameRegex);
                    if (matchMsg) expectedFilename = matchMsg[1];
                }

                // Clean ANSI
                const stripAnsi = (str: string) => str.replace(/\x1B\[[0-9;]*m/g, '');
                const cleanMsg = stripAnsi(errorMsg);
                
                let newSnapshot = '';
                const unexpectedValueToken = '- unexpected value "';
                const unexpectedValueIdx = cleanMsg.lastIndexOf(unexpectedValueToken);

                if (unexpectedValueIdx !== -1) {
                    const snapshotStart = unexpectedValueIdx + unexpectedValueToken.length;
                    const remaining = cleanMsg.substring(snapshotStart);
                    const lines = remaining.split('\n');
                    const extractedLines = [];
                    let foundEnd = false;
                    for (let i = 0; i < lines.length; i++) {
                        let line = lines[i].replace(/\r/g, '');
                        if (i === 0 && line.startsWith('- ')) {
                           extractedLines.push(line);
                        } else if (!foundEnd) {
                           if (line.endsWith('"') && (
                               i === lines.length - 1 || 
                               lines[i+1].trim() === '' || 
                               /^\s*\d+ × locator resolved/.test(lines[i+1])
                           )) {
                               foundEnd = true;
                               extractedLines.push(line.substring(0, line.length - 1));
                           } else {
                               extractedLines.push(line);
                           }
                        }
                    }
                    newSnapshot = extractedLines.join('\n');
                } else {
                    // Fallback to old diff string extraction if it does not have the 'unexpected value' Call log (e.g. older playwright versions)
                    const diffStart = cleanMsg.indexOf('@@');
                    const diffEnd = cleanMsg.indexOf('Call log:');
                    if (diffStart !== -1) {
                        const diffString = cleanMsg.substring(diffStart, diffEnd > -1 ? diffEnd : cleanMsg.length).trim();
                        const lines = diffString.split('\n');
                        const newSnapshotLines = [];
                        let inDiff = false;
                        for (let line of lines) {
                          line = line.replace(/\r/g, '');
                          if (line === 'Call log:') break;
                          if (!inDiff) {
                            if (line.startsWith('- Expected') || line.startsWith('+ Received') || line.trim() === '' || line.startsWith('Error:') || line.startsWith('Locator:') || line.startsWith('Timeout:')) {
                                continue;
                            }
                            if (line.startsWith('@@ ') || line.startsWith('- ') || line.startsWith('+ ') || line.startsWith('  ')) {
                                inDiff = true;
                            }
                          }
                          if (inDiff) {
                              if (line.startsWith('@@ ')) continue;
                              if (line.startsWith('+') || line.startsWith(' ')) {
                                newSnapshotLines.push(line.substring(1));
                              }
                          }
                        }
                        newSnapshot = newSnapshotLines.join('\n');
                    }
                }
                
                // Note: Content-based matching against the expected snapshot still requires knowing the expected snapshot.
                // Playwright doesn't print the *entire* expected file if it's too long in the diff,
                // but we don't necessarily need the expected string anymore because codeframe filename extraction works perfectly.
                // I will keep the existing expected string extraction around for the fallback content matching if codeframe fails.
                let expectedSnapshot = '';
                const diffStart = cleanMsg.indexOf('@@');
                const diffEnd = cleanMsg.indexOf('Call log:');
                if (diffStart !== -1) {
                        const diffString = cleanMsg.substring(diffStart, diffEnd > -1 ? diffEnd : cleanMsg.length).trim();
                        const lines = diffString.split('\n');
                        const expectedLines = [];
                        let inDiff = false;
                        for (let line of lines) {
                          line = line.replace(/\r/g, '');
                          if (line === 'Call log:') break;
                          if (!inDiff) {
                            if (line.startsWith('- Expected') || line.startsWith('+ Received') || line.trim() === '' || line.startsWith('Error:') || line.startsWith('Locator:') || line.startsWith('Timeout:')) {
                                continue;
                            }
                            if (line.startsWith('@@ ') || line.startsWith('- ') || line.startsWith('+ ') || line.startsWith('  ')) {
                                inDiff = true;
                            }
                          }
                          if (inDiff) {
                              if (line.startsWith('@@ ')) continue;
                              if (line.startsWith('-') || line.startsWith(' ')) {
                                expectedLines.push(line.substring(1));
                              }
                          }
                        }
                        expectedSnapshot = expectedLines.join('\n');
                }
                
                // Determine aria snapshots directory
                let testAriaDir = `src/test-data/aria-snapshots/${test.location.file}`;
                try {
                    const configTs = path.join(appConfig.projectPath!, 'playwright.config.ts');
                    const configJs = path.join(appConfig.projectPath!, 'playwright.config.js');
                    const configPath = fs.existsSync(configTs) ? configTs : fs.existsSync(configJs) ? configJs : '';
                    if (configPath) {
                        const cfg = jiti(configPath);
                        const resolvedCfg = cfg.default || cfg;
                        if (resolvedCfg.expect?.toMatchAriaSnapshot?.pathTemplate) {
                            const template = resolvedCfg.expect.toMatchAriaSnapshot.pathTemplate;
                            const parsedRelPath = path.parse(test.location.file);
                            let resolvedDirTemplate = template
                                .replace(/\{(.)?testFilePath\}/g, test.location.file)
                                .replace(/\{(.)?testFileName\}/g, parsedRelPath.base)
                                .replace(/\{(.)?testFileDir\}/g, parsedRelPath.dir);
                            testAriaDir = resolvedDirTemplate.substring(0, resolvedDirTemplate.lastIndexOf('/'));
                        }
                    }
                } catch(e) { /* fallback to default */ }
                
                let expectedPath = expectedFilename ? path.join(testAriaDir, expectedFilename) : '';
                
                // Content-based matching logic
                const isContentMatch = (filePath: string, expectedContentStr: string) => {
                    try {
                        const content = fs.readFileSync(path.join(appConfig.projectPath!, filePath), 'utf8');
                        // Use a softer trim since aria snapshots often have specific whitespace but trailing space can differ
                        return content.trim() === expectedContentStr.trim();
                    } catch (e) { return false; }
                };

                let foundPath = '';
                if (expectedPath && isContentMatch(expectedPath, expectedSnapshot)) {
                    foundPath = expectedPath;
                } else {
                    const absoluteAriaDir = path.join(appConfig.projectPath!, testAriaDir);
                    if (fs.existsSync(absoluteAriaDir)) {
                        const files = fs.readdirSync(absoluteAriaDir);
                        for (const file of files) {
                            if (!file.endsWith('.yml')) continue;
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
                    expectedPath = 'UNRESOLVED_PATH.yml';
                }

                let expectedSnapshotText = '';
                if (expectedPath && expectedPath !== 'UNRESOLVED_PATH.yml') {
                    try {
                        expectedSnapshotText = fs.readFileSync(path.join(appConfig.projectPath!, expectedPath), 'utf8')
                            .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                    } catch (e) {
                        console.error('Failed to read expected snapshot from disk', e);
                    }
                }

                if (!snapshotsToFix.some(s => s.newSnapshot === newSnapshot)) {
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
    res.status(500).json({ error: "Failed to extract aria snapshots: " + error.message });
  }
});

// Aria Snapshot Fixing Endpoint
app.post('/api/fix-aria-snapshot', (req: Request, res: Response): any => {
    const { snapshotPath, newContent } = req.body;
    
    if (!snapshotPath || newContent === undefined) {
        return res.status(400).json({ error: "snapshotPath and newContent are required." });
    }
    
    if (!appConfig.projectPath) {
       return res.status(400).json({ error: "Project path is not configured" });
    }
    
    try {
        const absolutePath = path.join(appConfig.projectPath, snapshotPath);
        
        // Ensure path is within projectPath for security
        if (!absolutePath.startsWith(appConfig.projectPath)) {
            return res.status(403).json({ error: "Invalid snapshot path" });
        }
        
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        
        fs.writeFileSync(absolutePath, newContent, 'utf8');
        res.json({ success: true, message: "Aria snapshot updated successfully." });
    } catch(error: any) {
        console.error("Failed to fix aria snapshot:", error);
        res.status(500).json({ error: "Failed to update aria snapshot: " + error.message });
    }
});

// Fallback to dashboard for any missing routes
app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/runner')) {
    res.sendFile(path.join(publicDir, 'runner.html'));
  } else {
    res.sendFile(path.join(publicDir, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Playwright Report Viewer is running on http://localhost:${PORT}`);
});
