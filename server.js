const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS if you need to fetch from other origins
app.use(cors());

// Serve the dashboard UI from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_FILE = path.join(__dirname, 'config.json');

// Helper to load saved paths
const getSavedPaths = () => {
  const defaultPaths = { currentPath: "", archivePath: "" };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      
      // Migrate old config if it exists
      if (config.reportsPath && !config.currentPath) {
        config.currentPath = config.reportsPath;
      }
      
      return {
        currentPath: config.currentPath || "",
        archivePath: config.archivePath || ""
      };
    }
  } catch (error) {
    console.error("Failed to read config:", error);
  }
  return defaultPaths;
};

let paths = getSavedPaths();

// Enable JSON body parsing for our API
app.use(express.json());

// Serve the reports dynamically using isolated mount points
app.use('/reports/current', (req, res, next) => {
  if (paths.currentPath && fs.existsSync(paths.currentPath)) {
    express.static(paths.currentPath)(req, res, next);
  } else {
    next();
  }
});

app.use('/reports/archive', (req, res, next) => {
  if (paths.archivePath && fs.existsSync(paths.archivePath)) {
    express.static(paths.archivePath)(req, res, next);
  } else {
    next();
  }
});

// API Endpoint to get the current configured paths
app.get('/api/current-paths', (req, res) => {
  res.json(paths);
});

// Helper to validate a path
const validatePath = (dirPath) => {
  if (!dirPath) return true; // Empty path is valid (clearing it)
  if (!fs.existsSync(dirPath)) throw new Error(`Directory does not exist: ${dirPath}`);
  if (!fs.statSync(dirPath).isDirectory()) throw new Error(`Path is not a directory: ${dirPath}`);
  return true;
};

// API Endpoint to update the reports paths
app.post('/api/set-paths', (req, res) => {
  const { currentPath, archivePath } = req.body;
  
  try {
    // Validate both
    if (currentPath) validatePath(currentPath);
    if (archivePath) validatePath(archivePath);

    // Clean paths
    const newPaths = {
      currentPath: currentPath ? currentPath.trim() : "",
      archivePath: archivePath ? archivePath.trim() : ""
    };

    // Save to file persistently
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newPaths, null, 2));
    
    // Update active runtime variable
    paths = newPaths;
    res.json({ success: true, paths });
  } catch (error) {
    console.error("Validation/Save error:", error.message);
    res.status(400).json({ error: error.message });
  }
});

// Helper to scan a directory for valid reports
const scanDirectory = (dirPath, prefix) => {
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
          const hasIndex = fs.existsSync(path.join(folderPath, 'index.html'));
          if (!hasIndex) return null;

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
    .filter(Boolean) // Remove invalid folders
    // Sort by modified date descending (newest first)
    .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
};

// API Endpoint to get the list of available reports
app.get('/api/reports', (req, res) => {
  res.json({
    current: scanDirectory(paths.currentPath, 'current'),
    archive: scanDirectory(paths.archivePath, 'archive')
  });
});

// Auto-extract traces endpoint
app.post('/api/extract', (req, res) => {
  const { reportPath } = req.body;
  if (!reportPath) return res.status(400).json({ error: "reportPath is required" });

  try {
    // 1. Determine which base directory this is from (current vs archive)
    const isArchive = reportPath.startsWith('/reports/archive/');
    const basePath = isArchive ? paths.archivePath : paths.currentPath;
    
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
    
  } catch (error) {
    console.error("Extraction error:", error);
    res.status(500).json({ error: "Failed to extract trace files: " + error.message });
  }
});

// Auto-archive report endpoint
app.post('/api/archive', (req, res) => {
  const { reportPath } = req.body;
  
  if (!reportPath) return res.status(400).json({ error: "reportPath is required" });
  if (!paths.archivePath) return res.status(400).json({ error: "Archive directory is not configured! Please open Preferences and set an archive path first." });

  try {
    // Determine source directory
    const isArchive = reportPath.startsWith('/reports/archive/');
    if (isArchive) return res.status(400).json({ error: "Report is already in the archive" });
    
    if (!paths.currentPath) return res.status(400).json({ error: "Current directory not configured" });

    // Extract the actual report folder name from the URL path
    const urlParts = reportPath.split('/');
    if (urlParts.length < 4) return res.status(400).json({ error: "Invalid report path format" });
    
    const folderName = urlParts[3]; 

    // Construct the absolute physical source path
    const sourcePhysicalFolder = path.join(paths.currentPath, folderName);
    
    if (!fs.existsSync(sourcePhysicalFolder)) {
      return res.status(404).json({ error: "Report folder not found on disk" });
    }

    // Construct unique destination physical path
    const uniqueArchivedName = `playwright-report-${Date.now()}`;
    const destinationPhysicalFolder = path.join(paths.archivePath, uniqueArchivedName);

    try {
      // Fast path: same drive move
      fs.renameSync(sourcePhysicalFolder, destinationPhysicalFolder);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV') {
        // Slow path: cross drive move (copy then delete)
        fs.cpSync(sourcePhysicalFolder, destinationPhysicalFolder, { recursive: true });
        fs.rmSync(sourcePhysicalFolder, { recursive: true, force: true });
      } else {
        throw renameErr; // Bubble up other I/O errors
      }
    }

    res.json({ success: true, newName: uniqueArchivedName });
    
  } catch (error) {
    console.error("Archive error:", error);
    res.status(500).json({ error: "Failed to archive report: " + error.message });
  }
});

// Fallback to dashboard for any missing routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Playwright Report Viewer is running on http://localhost:${PORT}`);
});
