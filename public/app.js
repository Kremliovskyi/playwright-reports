document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const currentSection = document.getElementById('current-section');
  const currentTable = currentSection.querySelector('.reports-table');
  const currentTbody = document.getElementById('current-tbody');
  
  const archiveSection = document.getElementById('archive-section');
  const archiveTable = archiveSection.querySelector('.reports-table');
  const archiveTbody = document.getElementById('archive-tbody');

  const loading = document.getElementById('loading');
  const emptyState = document.getElementById('empty-state');
  const refreshBtn = document.getElementById('refresh-btn');

  // Modal Elements
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeModalBtn = document.getElementById('close-modal-btn');
  const cancelModalBtn = document.getElementById('cancel-modal-btn');
  const saveModalBtn = document.getElementById('save-modal-btn');
  
  const currentPathInput = document.getElementById('current-path-input');
  const archivePathInput = document.getElementById('archive-path-input');
  const modalError = document.getElementById('modal-error');

  // Format date nicely
  const formatDate = (dateString) => {
      const options = { 
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit'
      };
      return new Date(dateString).toLocaleDateString(undefined, options);
  };

  // Create highly interactive report row
  const createReportRow = (report) => {
      const tr = document.createElement('tr');
      tr.className = 'report-row';
      tr.dataset.path = report.path; // Store path for table-level extraction
      
      const isCurrent = report.path.startsWith('/reports/current/');

      tr.addEventListener('click', (e) => {
          // Don't open report if clicking action buttons
          if (e.target.closest('.btn-extract') || e.target.closest('.btn-archive')) return;
          window.open(report.path, '_blank', 'noopener,noreferrer');
      });

      const archiveButtonHtml = isCurrent ? `
        <button class="btn btn-archive" aria-label="Archive Report">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-output"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="m9 14 3 3 3-3"/></svg>
            Archive
        </button>
      ` : '';

      tr.innerHTML = `
          <td class="col-date">
              <div class="date-wrapper">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                  <span>${formatDate(report.createdAt)}</span>
              </div>
          </td>
          <td class="col-origin">
              <span class="origin-label">${report.name}</span>
          </td>
          <td class="col-action">
              <div style="display: flex; gap: 8px;">
                  <button class="btn btn-extract" aria-label="Extract Traces">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-archive"><rect width="20" height="8" x="2" y="3" rx="1" ry="1"/><path d="M4 11v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="10 15 12 17 14 15"/><line x1="12" x2="12" y1="11" y2="17"/></svg>
                      Extract
                  </button>
                  ${archiveButtonHtml}
                  <a href="${report.path}" target="_blank" rel="noopener noreferrer" class="btn-open" aria-label="Open Report">
                      View Report
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                  </a>
              </div>
          </td>
      `;

      // Wire up extract button
      const extractBtn = tr.querySelector('.btn-extract');
      extractBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await handleExtract(report.path, extractBtn);
      });

      // Wire up archive button conditionally
      if (isCurrent) {
        const archiveBtn = tr.querySelector('.btn-archive');
        archiveBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await handleArchive(report.path, archiveBtn);
        });
      }

      return tr;
  };

  // Logic to handle individual extraction
  const handleExtract = async (reportPath, btnElement) => {
      const originalHtml = btnElement.innerHTML;
      btnElement.disabled = true;
      btnElement.innerHTML = `<div class="spinner" style="width: 12px; height: 12px; margin-right: 4px; border-width: 2px;"></div> Extracting...`;
      
      try {
          const response = await fetch('/api/extract', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reportPath })
          });
          const data = await response.json();
          
          if (!response.ok) throw new Error(data.error);
          
          btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg> Extracted`;
          btnElement.classList.add('success');
      } catch (err) {
          console.error("Extraction failed API call:", err);
          btnElement.innerHTML = `Error`;
          btnElement.classList.add('error');
      } finally {
          setTimeout(() => {
              btnElement.disabled = false;
              btnElement.innerHTML = originalHtml;
              btnElement.classList.remove('success', 'error');
          }, 3000);
      }
  };

  // Logic to handle moving current to archive
  const handleArchive = async (reportPath, btnElement) => {
      const originalHtml = btnElement.innerHTML;
      btnElement.disabled = true;
      btnElement.innerHTML = `<div class="spinner" style="width: 12px; height: 12px; margin-right: 4px; border-width: 2px;"></div> Archiving...`;
      
      try {
          const response = await fetch('/api/archive', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reportPath })
          });
          const data = await response.json();
          
          if (!response.ok) {
              // Custom alert for unconfigured archive
              if (data.error && data.error.includes("Archive directory is not configured")) {
                 alert("⚠️ " + data.error);
              }
              throw new Error(data.error);
          }
          
          btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg> Archiving Complete`;
          btnElement.classList.add('success');
          
          // Refresh entire UI to slide it into bottom table!
          setTimeout(() => {
              fetchReports();
          }, 800);

      } catch (err) {
          console.error("Archive failed API call:", err);
          btnElement.innerHTML = `Error`;
          btnElement.classList.add('error');
          setTimeout(() => {
              btnElement.disabled = false;
              btnElement.innerHTML = originalHtml;
              btnElement.classList.remove('success', 'error');
          }, 3000);
      } 
  };

  const renderTable = (reports, tbody, section, table) => {
      tbody.innerHTML = '';
      if (!reports || reports.length === 0) {
          section.classList.add('hidden');
          return 0;
      }
      
      section.classList.remove('hidden');
      table.classList.remove('hidden');
      reports.forEach(report => tbody.appendChild(createReportRow(report)));
      return reports.length;
  };

  const fetchReports = async () => {
      // Reset State
      currentSection.classList.add('hidden');
      archiveSection.classList.add('hidden');
      loading.classList.remove('hidden');
      emptyState.classList.add('hidden');

      try {
          const response = await fetch('/api/reports');
          const data = await response.json();

          loading.classList.add('hidden');

          const currentCount = renderTable(data.current, currentTbody, currentSection, currentTable);
          const archiveCount = renderTable(data.archive, archiveTbody, archiveSection, archiveTable);

          const { configStatus } = data;
          
          // Check if user set the configuration paths
          if (!configStatus || (!configStatus.hasCurrent && !configStatus.hasArchive)) {
              emptyState.classList.remove('hidden');
              emptyState.querySelector('h3').textContent = "Configuration Required";
              emptyState.querySelector('p').textContent = "Please open Preferences and configure your report directories to view them here.";
          } else if (currentCount === 0 && archiveCount === 0) {
              // Directories configured, but no reports inside them
              emptyState.classList.remove('hidden');
              emptyState.querySelector('h3').textContent = "No Reports Found";
              emptyState.querySelector('p').innerHTML = "No valid Playwright HTML reports could be found in your configured directories.<br><br>Make sure the selected folders actually contain test runs and the innermost folders contain an <code>index.html</code> right at their root.";
          }

      } catch (error) {
          console.error("Failed to fetch reports:", error);
          loading.classList.add('hidden');
          emptyState.classList.remove('hidden');
          emptyState.querySelector('h3').textContent = "Error loading reports";
          emptyState.querySelector('p').textContent = error.message;
      }
  };

  // --- Modal Logic ---

  const openModal = async () => {
      modalError.classList.add('hidden');
      settingsModal.classList.remove('hidden');
      
      try {
          const response = await fetch('/api/current-paths');
          const data = await response.json();
          currentPathInput.value = data.currentPath || '';
          archivePathInput.value = data.archivePath || '';
      } catch (err) {
          console.error("Failed to load paths:", err);
      }
  };

  const closeModal = () => {
      settingsModal.classList.add('hidden');
  };

  settingsBtn.addEventListener('click', openModal);
  closeModalBtn.addEventListener('click', closeModal);
  cancelModalBtn.addEventListener('click', closeModal);

  // Close when clicking outside modal content
  settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeModal();
  });

  saveModalBtn.addEventListener('click', async () => {
      const currentPath = currentPathInput.value.trim();
      const archivePath = archivePathInput.value.trim();

      modalError.classList.add('hidden');
      saveModalBtn.disabled = true;
      saveModalBtn.textContent = 'Saving...';

      try {
          const response = await fetch('/api/set-paths', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ currentPath, archivePath })
          });
          
          const data = await response.json();
          
          if (!response.ok) {
              throw new Error(data.error || 'Failed to update paths');
          }
          
          closeModal();
          await fetchReports();
          
      } catch (err) {
          modalError.textContent = err.message;
          modalError.classList.remove('hidden');
      } finally {
          saveModalBtn.disabled = false;
          saveModalBtn.textContent = 'Save Changes';
      }
  });

  // --- Toolbars & Globals ---

  const extractAllBtns = document.querySelectorAll('.extract-all-btn');
  extractAllBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
          const target = btn.dataset.target; // "current" or "archive"
          const tbody = document.getElementById(`${target}-tbody`);
          const rows = tbody.querySelectorAll('.report-row');
          
          if (rows.length === 0) return;

          const originalHtml = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = `<div class="spinner" style="width: 14px; height: 14px; margin-right: 6px; border-width: 2px;"></div> Extracting All...`;

          // Process sequentially to not overload Node.js/Disk
          for (const row of Array.from(rows)) {
              const extractBtn = row.querySelector('.btn-extract');
              // Only extract if not already extracted (in UI state)
              if (!extractBtn.disabled && !extractBtn.classList.contains('success')) {
                  await handleExtract(row.dataset.path, extractBtn);
              }
          }

          btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> All Extracted`;
          btn.classList.add('success');
          
          setTimeout(() => {
              btn.disabled = false;
              btn.classList.remove('success');
              btn.innerHTML = originalHtml;
          }, 4000);
      });
  });

  refreshBtn.addEventListener('click', () => {
      const icon = refreshBtn.querySelector('svg');
      icon.style.transition = 'transform 0.5s ease';
      icon.style.transform = `rotate(360deg)`;
      
      fetchReports().then(() => {
          setTimeout(() => {
              icon.style.transition = 'none';
              icon.style.transform = `rotate(0deg)`;
          }, 500);
      });
  });

  // Initial fetch
  fetchReports();
});
