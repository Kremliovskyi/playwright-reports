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

// Serve the reports dynamically
// Playwright reports have many static assets, so we serve the entire reports folder statically
app.use('/reports', express.static(path.join(__dirname, 'reports')));

// API Endpoint to get the list of available reports
app.get('/api/reports', (req, res) => {
  const reportsDir = path.join(__dirname, 'reports');
  
  if (!fs.existsSync(reportsDir)) {
    return res.json([]);
  }

  // Read all directories inside 'reports'
  const entries = fs.readdirSync(reportsDir, { withFileTypes: true });
  
  const reports = entries
    .filter(dirent => dirent.isDirectory())
    .map(dirent => {
      const folderPath = path.join(reportsDir, dirent.name);
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
