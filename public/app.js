document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('reports-grid');
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

  // Create highly interactive report card
  const createReportCard = (report) => {
      const a = document.createElement('a');
      a.href = report.path;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'report-card';

      a.innerHTML = `
          <div class="card-header">
              <div class="card-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-bar-chart-2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-4"/><path d="M8 18v-2"/><path d="M16 18v-6"/></svg>
              </div>
          </div>
          <h3 class="card-title">${report.name}</h3>
          <div class="card-meta">
              <span class="meta-item">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                  Created: ${formatDate(report.createdAt)}
              </span>
          </div>
          <div class="card-footer">
              <span class="open-link">
                  Open Report
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-external-link"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
              </span>
          </div>
      `;
      return a;
  };

  const fetchReports = async () => {
      // Show loading
      grid.innerHTML = '';
      grid.appendChild(loading);
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

          reports.forEach(report => {
              grid.appendChild(createReportCard(report));
          });
      } catch (error) {
          console.error("Failed to fetch reports:", error);
          loading.classList.add('hidden');
          emptyState.classList.remove('hidden');
          emptyState.querySelector('h3').textContent = "Error loading reports";
          emptyState.querySelector('p').textContent = error.message;
      }
  };

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
  fetchReports();
});
