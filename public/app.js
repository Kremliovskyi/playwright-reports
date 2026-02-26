document.addEventListener('DOMContentLoaded', () => {
  const table = document.getElementById('reports-table');
  const tbody = document.getElementById('reports-tbody');
  const loading = document.getElementById('loading');
  const emptyState = document.getElementById('empty-state');
  const refreshBtn = document.getElementById('refresh-btn');

  // Format date nicely
  const formatDate = (dateString) => {
      const options = { 
          year: 'numeric', 
          month: 'short', 
          day: 'numeric',
          hour: '2-digit', 
          minute: '2-digit'
      };
      return new Date(dateString).toLocaleDateString(undefined, options);
  };

  // Create highly interactive report row
  const createReportRow = (report) => {
      const tr = document.createElement('tr');
      tr.className = 'report-row';
      tr.addEventListener('click', () => {
          window.open(report.path, '_blank', 'noopener,noreferrer');
      });

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
              <a href="${report.path}" target="_blank" rel="noopener noreferrer" class="btn-open" aria-label="Open Report">
                  View Report
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              </a>
          </td>
      `;
      return tr;
  };

  const fetchReports = async () => {
      // Show loading
      tbody.innerHTML = '';
      table.classList.add('hidden');
      loading.classList.remove('hidden');
      emptyState.classList.add('hidden');

      try {
          const response = await fetch('/api/reports');
          const reports = await response.json();

          loading.classList.add('hidden');

          if (reports.length === 0) {
              emptyState.classList.remove('hidden');
              return;
          }

          table.classList.remove('hidden');
          reports.forEach(report => {
              tbody.appendChild(createReportRow(report));
          });
      } catch (error) {
          console.error("Failed to fetch reports:", error);
          loading.classList.add('hidden');
          emptyState.classList.remove('hidden');
          emptyState.querySelector('h3').textContent = "Error loading reports";
          emptyState.querySelector('p').textContent = error.message;
      }
  };

  const pathInput = document.getElementById('report-path-input');
  const updatePathBtn = document.getElementById('update-path-btn');
  const pathError = document.getElementById('path-error');

  const fetchCurrentPath = async () => {
      try {
          const response = await fetch('/api/current-path');
          const data = await response.json();
          if (data.path) {
              pathInput.value = data.path;
          }
      } catch (err) {
          console.error("Failed to load current path:", err);
      }
  };

  updatePathBtn.addEventListener('click', async () => {
      const newPath = pathInput.value.trim();
      if (!newPath) return;

      pathError.classList.add('hidden');
      updatePathBtn.disabled = true;
      updatePathBtn.textContent = 'Saving...';

      try {
          const response = await fetch('/api/set-path', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ newPath })
          });
          
          const data = await response.json();
          
          if (!response.ok) {
              throw new Error(data.error || 'Failed to update path');
          }
          
          // Successfully updated, refresh reports!
          updatePathBtn.textContent = 'Saved!';
          await fetchReports();
          
      } catch (err) {
          pathError.textContent = err.message;
          pathError.classList.remove('hidden');
      } finally {
          setTimeout(() => {
              updatePathBtn.disabled = false;
              updatePathBtn.textContent = 'Set Path';
          }, 2000);
      }
  });

  refreshBtn.addEventListener('click', () => {
      // Add subtle spin animation on click
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
  fetchCurrentPath();
  fetchReports();
});
