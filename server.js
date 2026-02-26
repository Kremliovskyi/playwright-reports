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

// Helper to load saved path
const getSavedPath = () => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.reportsPath && fs.existsSync(config.reportsPath)) {
        return config.reportsPath;
      }
    }
  } catch (error) {
    console.error("Failed to read config:", error);
  }
  // Default fallback
  return path.join(__dirname, 'reports');
};

let currentReportsDir = getSavedPath();

// Enable JSON body parsing for our API
app.use(express.json());

// Serve the reports dynamically from the strictly current directory
app.use('/reports', (req, res, next) => {
  express.static(currentReportsDir)(req, res, next);
});

// API Endpoint to get the current configured path
app.get('/api/current-path', (req, res) => {
  res.json({ path: currentReportsDir });
});

// API Endpoint to update the reports path
app.post('/api/set-path', (req, res) => {
  const { newPath } = req.body;
  
  if (!newPath) {
    return res.status(400).json({ error: "No path provided." });
  }

  // Basic validation that it's an existing directory
  if (!fs.existsSync(newPath)) {
    return res.status(400).json({ error: "The provided directory does not exist on the server." });
  }

  if (!fs.statSync(newPath).isDirectory()) {
    return res.status(400).json({ error: "The provided path is a file, not a directory." });
  }

  try {
    // Save to file persistently
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ reportsPath: newPath }, null, 2));
    
    // Update active runtime variable
    currentReportsDir = newPath;
    res.json({ success: true, path: currentReportsDir });
  } catch (error) {
    console.error("Failed to save new path:", error);
    res.status(500).json({ error: "Failed to save configuration." });
  }
});

// API Endpoint to get the list of available reports
app.get('/api/reports', (req, res) => {
  if (!fs.existsSync(currentReportsDir)) {
    return res.json([]);
  }

  let entries;
  try {
    // Read all directories inside the active reports dir
    entries = fs.readdirSync(currentReportsDir, { withFileTypes: true });
  } catch (error) {
    console.error("Could not read directory:", currentReportsDir);
    return res.json([]);
  }
  
  const reports = entries
    .filter(dirent => dirent.isDirectory())
    .map(dirent => {
      const folderPath = path.join(currentReportsDir, dirent.name);
      
      try {
          const stat = fs.statSync(folderPath);
          
          // Check if index.html exists in this folder to confirm it's a valid report
          const hasIndex = fs.existsSync(path.join(folderPath, 'index.html'));
          if (!hasIndex) return null;

          return {
            id: dirent.name,
            name: dirent.name.replace(/[-_]/g, ' '), // Prettify folder name
            path: `/reports/${dirent.name}/index.html`,
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

  res.json(reports);
});

// Fallback to dashboard for any missing routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Playwright Report Viewer is running on http://localhost:${PORT}`);
});
