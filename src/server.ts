import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { spawn, ChildProcess } from 'child_process';
import { createJiti } from 'jiti';
import treeKill from 'tree-kill';

const jiti = createJiti(__filename, { moduleCache: false });

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS if you need to fetch from other origins
app.use(cors());

// Determine the correct public directory based on whether we are running from dist/ or src/
const isBuild = __dirname.endsWith('dist');
const publicDir = isBuild ? path.join(__dirname, 'public') : path.join(__dirname, 'public');

// Serve the dashboard UI from the 'public' folder
app.use(express.static(publicDir));

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

interface AppConfig {
  currentPath: string;
  archivePath: string;
  projectPath: string;
  runnerOptions: {
    headed: boolean;
    ui: boolean;
    debug: boolean;
    updateSnapshots: boolean;
    grep: string;
    repeatEach: string;
    workers: string;
    envVariables: string;
  };
  selectedProjects: string[];
}

const DEFAULT_RUNNER_OPTIONS = {
  headed: false,
  ui: false,
  debug: false,
  updateSnapshots: false,
  grep: '',
  repeatEach: '',
  workers: '',
  envVariables: ''
};

// Helper to load saved paths
const getSavedPaths = (): AppConfig => {
  const defaultConfig: AppConfig = { 
    currentPath: "", 
    archivePath: "", 
    projectPath: "",
    runnerOptions: { ...DEFAULT_RUNNER_OPTIONS },
    selectedProjects: []
  };
  
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      
      // Migrate old config if it exists
      if (config.reportsPath && !config.currentPath) {
        config.currentPath = config.reportsPath;
      }
      
      return {
        currentPath: config.currentPath || "",
        archivePath: config.archivePath || "",
        projectPath: config.projectPath || "",
        runnerOptions: { ...DEFAULT_RUNNER_OPTIONS, ...(config.runnerOptions || {}) },
        selectedProjects: Array.isArray(config.selectedProjects) ? config.selectedProjects : []
      };
    }
  } catch (error) {
    console.error("Failed to read config:", error);
  }
  return defaultConfig;
};

let appConfig = getSavedPaths();

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

// API Endpoint to get the current configured paths and options
app.get('/api/config', (req: Request, res: Response) => {
  res.json(appConfig);
});

// Helper to validate a path
const validatePath = (dirPath: string): boolean => {
  if (!dirPath) return true; // Empty path is valid (clearing it)
  if (!fs.existsSync(dirPath)) throw new Error(`Directory does not exist: ${dirPath}`);
  if (!fs.statSync(dirPath).isDirectory()) throw new Error(`Path is not a directory: ${dirPath}`);
  return true;
};

// API Endpoint to update the reports paths or runner options
app.post('/api/config', (req: Request, res: Response): any => {
  const { currentPath, archivePath, projectPath, runnerOptions, selectedProjects } = req.body;
  
  try {
    // Validate paths if they are provided (for backwards compatibility with partial updates)
    if (currentPath !== undefined && currentPath !== null) validatePath(currentPath);
    if (archivePath !== undefined && archivePath !== null) validatePath(archivePath);
    if (projectPath !== undefined && projectPath !== null) validatePath(projectPath);

    // Merge new config
    const newConfig: AppConfig = {
      currentPath: currentPath !== undefined ? currentPath.trim() : appConfig.currentPath,
      archivePath: archivePath !== undefined ? archivePath.trim() : appConfig.archivePath,
      projectPath: projectPath !== undefined ? projectPath.trim() : appConfig.projectPath,
      runnerOptions: runnerOptions !== undefined ? { ...appConfig.runnerOptions, ...runnerOptions } : appConfig.runnerOptions,
      selectedProjects: selectedProjects !== undefined && Array.isArray(selectedProjects) ? selectedProjects : appConfig.selectedProjects
    };

    // Save to file persistently
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    
    // Update active runtime variable
    appConfig = newConfig;
    res.json({ success: true, config: appConfig });
  } catch (error: any) {
    console.error("Validation/Save error:", error.message);
    res.status(400).json({ error: error.message });
  }
});

interface ReportInfo {
  id: string;
  name: string;
  path: string;
  createdAt: Date;
  modifiedAt: Date;
}

// Helper to scan a directory for valid reports
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
  
  return entries
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

          return {
            id: dirent.name,
            name: dirent.name.replace(/[-_]/g, ' '), // Prettify folder name
            path: `/reports/${prefix}/${dirent.name}/index.html`,
            createdAt: stat.birthtime,
            modifiedAt: stat.mtime
          };
      } catch (err) {
          // If permission denied or other read error, skip safely
          return null;
      }
    })
    .filter((item): item is ReportInfo => item !== null) // Remove invalid folders and type guard
    // Sort by modified date descending (newest first)
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
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

    res.json({ success: true, newName: uniqueArchivedName });
    
  } catch (error: any) {
    console.error("Archive error:", error);
    res.status(500).json({ error: "Failed to archive report: " + error.message });
  }
});

// Fallback to dashboard for any missing routes
app.use((req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Playwright Report Viewer is running on http://localhost:${PORT}`);
});
