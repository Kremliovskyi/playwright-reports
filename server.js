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

// Fallback to dashboard for any missing routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Playwright Report Viewer is running on http://localhost:${PORT}`);
});
