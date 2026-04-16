interface Report {
    id: string;
    path: string;
    name: string;
    createdAt: string;
    metadata: string;
}

interface ReportsResponse {
    current: Report[];
    archive: Report[];
    configStatus: {
        hasCurrent: boolean;
        hasArchive: boolean;
        hasProject?: boolean;
    };
}

interface SearchFilters {
    query: string;
    rangeStart: string;
    rangeEnd: string;
}

interface SearchState {
    isOpen: boolean;
    draft: SearchFilters;
    applied: SearchFilters | null;
}

type SectionKey = 'current' | 'archive';

interface DeleteRequest {
    reportPaths: string[];
    title: string;
    message: string;
    confirmLabel: string;
}

interface TableContext {
    section: HTMLElement;
    table: HTMLElement;
    tbody: HTMLElement;
    selectAllBtn: HTMLButtonElement;
    selectNoneBtn: HTMLButtonElement;
    selectionCount: HTMLElement;
    bulkMenu: HTMLElement;
    bulkMenuTrigger: HTMLButtonElement;
    bulkMenuPanel: HTMLElement;
}

// Simple Diffing Logic
interface DiffLine {
    type: 'added' | 'removed' | 'unchanged';
    text: string;
}

function normalizeIndent(str: string): string {
    const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const indents = lines
        .filter(l => l.length > 0 && l.trimStart().length < l.length)
        .map(l => l.length - l.trimStart().length);
    const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
    if (minIndent === 0 || minIndent === 2) return normalized;
    return lines.map(l => {
        if (l.length === 0) return l;
        const spaces = l.length - l.trimStart().length;
        const level = Math.floor(spaces / minIndent);
        return ' '.repeat(level * 2) + l.trimStart();
    }).join('\n');
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
    const oldLines = oldStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const newLines = newStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    const prefix = '- /children: deep-equal';
    const cleanOldLines = oldLines[0] === prefix ? oldLines.slice(1) : oldLines;
    const cleanNewLines = newLines[0] === prefix ? newLines.slice(1) : newLines;

    // A basic Longest Common Subsequence (LCS) algorithm for diffing
    const m = cleanOldLines.length;
    const n = cleanNewLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (cleanOldLines[i - 1] === cleanNewLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const diff: DiffLine[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (cleanOldLines[i - 1] === cleanNewLines[j - 1]) {
            diff.unshift({ type: 'unchanged', text: cleanOldLines[i - 1] });
            i--;
            j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            diff.unshift({ type: 'removed', text: cleanOldLines[i - 1] });
            i--;
        } else {
            diff.unshift({ type: 'added', text: cleanNewLines[j - 1] });
            j--;
        }
    }
    while (i > 0) {
        diff.unshift({ type: 'removed', text: cleanOldLines[i - 1] });
        i--;
    }
    while (j > 0) {
        diff.unshift({ type: 'added', text: cleanNewLines[j - 1] });
        j--;
    }
    
    return diff;
}

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const currentSection = document.getElementById('current-section') as HTMLElement;
  const currentTable = currentSection.querySelector('.reports-table') as HTMLElement;
  const currentTbody = document.getElementById('current-tbody') as HTMLElement;
  
  const archiveSection = document.getElementById('archive-section') as HTMLElement;
  const archiveTable = archiveSection.querySelector('.reports-table') as HTMLElement;
  const archiveTbody = document.getElementById('archive-tbody') as HTMLElement;

  const loading = document.getElementById('loading') as HTMLElement;
  const emptyState = document.getElementById('empty-state') as HTMLElement;
  const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
    const searchToggleBtn = document.getElementById('search-toggle-btn') as HTMLButtonElement;
    const searchPanel = document.getElementById('search-panel') as HTMLElement;
    const searchCloseBtn = document.getElementById('search-close-btn') as HTMLButtonElement;
    const searchInput = document.getElementById('search-input') as HTMLInputElement;
    const searchSubmitBtn = document.getElementById('search-submit-btn') as HTMLButtonElement;
    const searchRangeStartInput = document.getElementById('search-range-start') as HTMLInputElement;
    const searchRangeEndInput = document.getElementById('search-range-end') as HTMLInputElement;
        const searchResetBtn = document.getElementById('search-reset-btn') as HTMLButtonElement;

  // Modal Elements
  const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
  const settingsModal = document.getElementById('settings-modal') as HTMLElement;
  const closeModalBtn = document.getElementById('close-modal-btn') as HTMLButtonElement;
  const cancelModalBtn = document.getElementById('cancel-modal-btn') as HTMLButtonElement;
  const saveModalBtn = document.getElementById('save-modal-btn') as HTMLButtonElement;
  
  const currentPathInput = document.getElementById('current-path-input') as HTMLInputElement;
  const archivePathInput = document.getElementById('archive-path-input') as HTMLInputElement;
  const projectPathInput = document.getElementById('project-path-input') as HTMLInputElement;
  const vaultPathInput = document.getElementById('vault-path-input') as HTMLInputElement;
  const modalError = document.getElementById('modal-error') as HTMLElement;

  const deleteModal = document.getElementById('delete-modal') as HTMLElement;
    const deleteModalTitle = document.getElementById('delete-modal-title') as HTMLElement;
    const deleteModalMessage = document.getElementById('delete-modal-message') as HTMLElement;
  const closeDeleteModalBtn = document.getElementById('close-delete-modal-btn') as HTMLButtonElement;
  const cancelDeleteBtn = document.getElementById('cancel-delete-btn') as HTMLButtonElement;
  const confirmDeleteBtn = document.getElementById('confirm-delete-btn') as HTMLButtonElement;
  const deleteModalError = document.getElementById('delete-modal-error') as HTMLElement;
  
  const ariaModal = document.getElementById('aria-modal') as HTMLElement;
  const ariaTbody = document.getElementById('aria-tbody') as HTMLElement;
  const closeAriaModalBtn = document.getElementById('close-aria-modal-btn') as HTMLButtonElement;
  
  const ariaPreviewModal = document.getElementById('aria-preview-modal') as HTMLElement;
  const ariaPreviewBody = document.getElementById('aria-preview-body') as HTMLElement;
  const closeAriaPreviewBtn = document.getElementById('close-aria-preview-btn') as HTMLButtonElement;
  const closeAriaPreviewFooterBtn = document.getElementById('close-aria-preview-footer-btn') as HTMLButtonElement;
  const ariaDeepEqualCheckbox = document.getElementById('aria-deep-equal-checkbox') as HTMLInputElement;
  const ariaPreviewSubtitle = document.getElementById('aria-preview-subtitle') as HTMLElement;

  const tableContexts: Record<SectionKey, TableContext> = {
      current: {
          section: currentSection,
          table: currentTable,
          tbody: currentTbody,
          selectAllBtn: document.querySelector('.select-all-btn[data-target="current"]') as HTMLButtonElement,
          selectNoneBtn: document.querySelector('.select-none-btn[data-target="current"]') as HTMLButtonElement,
          selectionCount: document.querySelector('.selection-count[data-target="current"]') as HTMLElement,
          bulkMenu: document.querySelector('.bulk-menu[data-target="current"]') as HTMLElement,
          bulkMenuTrigger: document.querySelector('.bulk-menu-trigger[data-target="current"]') as HTMLButtonElement,
          bulkMenuPanel: document.querySelector('.bulk-menu-panel[data-target="current"]') as HTMLElement
      },
      archive: {
          section: archiveSection,
          table: archiveTable,
          tbody: archiveTbody,
          selectAllBtn: document.querySelector('.select-all-btn[data-target="archive"]') as HTMLButtonElement,
          selectNoneBtn: document.querySelector('.select-none-btn[data-target="archive"]') as HTMLButtonElement,
          selectionCount: document.querySelector('.selection-count[data-target="archive"]') as HTMLElement,
          bulkMenu: document.querySelector('.bulk-menu[data-target="archive"]') as HTMLElement,
          bulkMenuTrigger: document.querySelector('.bulk-menu-trigger[data-target="archive"]') as HTMLButtonElement,
          bulkMenuPanel: document.querySelector('.bulk-menu-panel[data-target="archive"]') as HTMLElement
      }
  };

  const selectedReports: Record<SectionKey, Set<string>> = {
      current: new Set<string>(),
      archive: new Set<string>()
  };

  const lastSelectedReportPath: Record<SectionKey, string | null> = {
      current: null,
      archive: null
  };

  let deleteRequest: DeleteRequest | null = null;
  let activeBulkTarget: SectionKey | null = null;
  let vaultFiles: Set<string> = new Set();
    let cachedReportsData: ReportsResponse | null = null;
    let activeSearchState: SearchState = {
        isOpen: false,
        draft: {
        query: '',
        rangeStart: '',
        rangeEnd: ''
        },
        applied: null
    };

  const runTestsBtn = document.getElementById('run-tests-btn') as HTMLButtonElement;

  if (runTestsBtn) {
      const channel = new BroadcastChannel('runner_state');
      
      channel.onmessage = (event) => {
          if (event.data.state === 'open') {
              runTestsBtn.disabled = true;
              runTestsBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-terminal"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>
                Runner Active
              `;
              runTestsBtn.style.opacity = '0.7';
          } else if (event.data.state === 'closed') {
              runTestsBtn.disabled = false;
              runTestsBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                Run Tests
              `;
              runTestsBtn.style.opacity = '1';
          }
      };

      // Ask if runner is already open upon load
      channel.postMessage({ type: 'ping' });

      runTestsBtn.addEventListener('click', () => {
          // Temporarily disable to prevent double clicks before tab loads
          runTestsBtn.disabled = true;
          window.open('/runner.html', '_blank', 'noopener,noreferrer');
      });
  }

  // Format date nicely
  const formatDate = (dateString: string) => {
      const options: Intl.DateTimeFormatOptions = { 
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit'
      };
      return new Date(dateString).toLocaleDateString(undefined, options);
  };

  const setEmptyStateContent = (title: string, message: string, allowHtml: boolean = false) => {
      const heading = emptyState.querySelector('h3');
      const body = emptyState.querySelector('p');
      if (heading) heading.textContent = title;
      if (body) {
          if (allowHtml) {
              body.innerHTML = message;
          } else {
              body.textContent = message;
          }
      }
  };

  const resetRenderedState = (showLoading: boolean) => {
      currentSection.classList.add('hidden');
      archiveSection.classList.add('hidden');
      closeBulkMenus();
      selectedReports.current.clear();
      selectedReports.archive.clear();
      lastSelectedReportPath.current = null;
      lastSelectedReportPath.archive = null;
      emptyState.classList.add('hidden');
      loading.classList.toggle('hidden', !showLoading);
  };

  const createEmptySearchFilters = (): SearchFilters => ({
      query: '',
      rangeStart: '',
      rangeEnd: ''
  });

  const normalizeSearchFilters = (filters: SearchFilters): SearchFilters => ({
      query: filters.query.trim(),
      rangeStart: filters.rangeStart,
      rangeEnd: filters.rangeEnd
  });

  const readSearchInputs = (): SearchFilters => normalizeSearchFilters({
      query: searchInput.value,
      rangeStart: searchRangeStartInput.value,
      rangeEnd: searchRangeEndInput.value
  });

  const syncSearchInputs = (filters: SearchFilters) => {
      searchInput.value = filters.query;
      searchRangeStartInput.value = filters.rangeStart;
      searchRangeEndInput.value = filters.rangeEnd;
  };

  const hasSearchFilters = (filters: SearchFilters) => {
      return Boolean(filters.query || filters.rangeStart || filters.rangeEnd);
  };

  const setRefreshDisabled = (disabled: boolean) => {
      refreshBtn.disabled = disabled;
      refreshBtn.setAttribute('aria-disabled', String(disabled));
      refreshBtn.title = disabled ? 'Close search to refresh reports' : '';
  };

  const updateSearchButtonState = () => {
      const hasAppliedFilter = Boolean(activeSearchState.applied && hasSearchFilters(activeSearchState.applied));
      searchToggleBtn.classList.toggle('search-toggle-open', activeSearchState.isOpen);
      searchToggleBtn.classList.toggle('search-toggle-applied', hasAppliedFilter);
      searchToggleBtn.setAttribute('aria-expanded', String(activeSearchState.isOpen));
      setRefreshDisabled(activeSearchState.isOpen);
  };

  const buildSearchUrl = (filters: SearchFilters) => {
      const params = new URLSearchParams();
      if (filters.query) params.set('query', filters.query);
      if (filters.rangeStart) params.set('rangeStart', filters.rangeStart);
      if (filters.rangeEnd) params.set('rangeEnd', filters.rangeEnd);
      const queryString = params.toString();
      return queryString ? `/api/report-search?${queryString}` : '/api/report-search';
  };

  const setDraftFilters = (filters: SearchFilters) => {
      activeSearchState.draft = normalizeSearchFilters(filters);
      syncSearchInputs(activeSearchState.draft);
  };

  const setAppliedFilters = (filters: SearchFilters | null) => {
      const normalized = filters ? normalizeSearchFilters(filters) : null;
      activeSearchState.applied = normalized && hasSearchFilters(normalized) ? normalized : null;
      setDraftFilters(activeSearchState.applied || createEmptySearchFilters());
      updateSearchButtonState();
  };

  const requestReports = async (url: string): Promise<ReportsResponse> => {
      const response = await fetch(url);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
          throw new Error(data.error || 'Failed to load reports');
      }
      return data as ReportsResponse;
  };

  const updateCachedReportMetadata = (reportId: string, metadata: string) => {
      if (!cachedReportsData) return;
      [...cachedReportsData.current, ...cachedReportsData.archive].forEach(report => {
          if (report.id === reportId) {
              report.metadata = metadata;
          }
      });
  };

  const updateCachedRenamedReport = (previousPath: string, newId: string, newPath: string, newName: string) => {
      if (!cachedReportsData) return;
      cachedReportsData.current.forEach(report => {
          if (report.path === previousPath) {
              report.id = newId;
              report.name = newName;
              report.path = newPath;
          }
      });
  };

  const closeBulkMenus = () => {
      (Object.keys(tableContexts) as SectionKey[]).forEach(target => {
          const context = tableContexts[target];
          context.bulkMenuPanel.classList.add('hidden');
          context.bulkMenuTrigger.setAttribute('aria-expanded', 'false');
      });
  };

  const closeAllOverflowMenus = () => {
      document.querySelectorAll('.row-overflow-panel').forEach(panel => {
          panel.classList.add('hidden');
      });
      document.querySelectorAll('.row-overflow-trigger').forEach(trigger => {
          trigger.setAttribute('aria-expanded', 'false');
      });
  };

  const syncBulkControls = (target: SectionKey) => {
      const context = tableContexts[target];
      const selectionCount = selectedReports[target].size;
      const isBusy = activeBulkTarget === target;

      context.selectionCount.textContent = `${selectionCount} selected`;
      context.selectionCount.classList.toggle('hidden', selectionCount === 0);
      context.selectNoneBtn.disabled = selectionCount === 0 || isBusy;
      context.bulkMenu.classList.toggle('hidden', selectionCount === 0);
      context.bulkMenuTrigger.disabled = selectionCount === 0 || isBusy;

      const menuActions = context.bulkMenuPanel.querySelectorAll<HTMLButtonElement>('.bulk-menu-action');
      menuActions.forEach(actionBtn => {
          actionBtn.disabled = isBusy;
      });

      if (selectionCount === 0 || isBusy) {
          context.bulkMenuPanel.classList.add('hidden');
          context.bulkMenuTrigger.setAttribute('aria-expanded', 'false');
      }

      const rows = context.tbody.querySelectorAll<HTMLTableRowElement>('.report-row');
      rows.forEach(row => {
          const checkbox = row.querySelector<HTMLInputElement>('.row-select-checkbox');
          row.classList.toggle('selected', checkbox?.checked ?? false);
      });
  };

  const syncAllBulkControls = () => {
      syncBulkControls('current');
      syncBulkControls('archive');
  };

  const setSelectionControlsDisabled = (target: SectionKey, disabled: boolean) => {
      const context = tableContexts[target];
      context.selectAllBtn.disabled = disabled;
      context.selectNoneBtn.disabled = disabled || selectedReports[target].size === 0;
      context.bulkMenuTrigger.disabled = disabled || selectedReports[target].size === 0;

      const checkboxes = context.tbody.querySelectorAll<HTMLInputElement>('.row-select-checkbox');
      checkboxes.forEach(checkbox => {
          checkbox.disabled = disabled;
      });

      const actionButtons = context.bulkMenuPanel.querySelectorAll<HTMLButtonElement>('.bulk-menu-action');
      actionButtons.forEach(button => {
          button.disabled = disabled;
      });
  };

  const setRowSelection = (target: SectionKey, reportPath: string, checked: boolean, row: HTMLTableRowElement) => {
      if (checked) {
          selectedReports[target].add(reportPath);
      } else {
          selectedReports[target].delete(reportPath);
      }

      row.classList.toggle('selected', checked);
      syncBulkControls(target);
  };

  const clearSelection = (target: SectionKey) => {
      const context = tableContexts[target];
      selectedReports[target].clear();
      lastSelectedReportPath[target] = null;
      const checkboxes = context.tbody.querySelectorAll<HTMLInputElement>('.row-select-checkbox');
      checkboxes.forEach(checkbox => {
          checkbox.checked = false;
      });
      syncBulkControls(target);
  };

  const selectAllRows = (target: SectionKey) => {
      const context = tableContexts[target];
      const checkboxes = context.tbody.querySelectorAll<HTMLInputElement>('.row-select-checkbox');
      selectedReports[target].clear();
      lastSelectedReportPath[target] = null;
      checkboxes.forEach(checkbox => {
          const reportPath = checkbox.dataset.reportPath;
          if (!reportPath) return;
          checkbox.checked = true;
          selectedReports[target].add(reportPath);
      });
      syncBulkControls(target);
  };

  const setRangeSelection = (target: SectionKey, anchorPath: string, currentPath: string) => {
      const context = tableContexts[target];
      const rows = Array.from(context.tbody.querySelectorAll<HTMLTableRowElement>('.report-row'));
      const startIndex = rows.findIndex(row => row.dataset.path === anchorPath);
      const endIndex = rows.findIndex(row => row.dataset.path === currentPath);

      if (startIndex === -1 || endIndex === -1) {
          return false;
      }

      const [fromIndex, toIndex] = startIndex <= endIndex
          ? [startIndex, endIndex]
          : [endIndex, startIndex];

      for (let index = fromIndex; index <= toIndex; index++) {
          const row = rows[index];
          const checkbox = row.querySelector<HTMLInputElement>('.row-select-checkbox');
          const reportPath = checkbox?.dataset.reportPath;
          if (!checkbox || !reportPath) continue;

          checkbox.checked = true;
          selectedReports[target].add(reportPath);
          row.classList.add('selected');
      }

      syncBulkControls(target);
      return true;
  };

  const getTableLabel = (target: SectionKey) => target === 'current' ? 'current' : 'archived';

  const performDeleteRequests = async (reportPaths: string[]) => {
      const failures: string[] = [];

      for (const reportPath of reportPaths) {
          try {
              const response = await fetch('/api/delete', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ reportPath })
              });

              const data = await response.json();
              if (!response.ok) {
                  throw new Error(data.error || 'Failed to delete report');
              }
          } catch (error: any) {
              failures.push(error.message || 'Failed to delete report');
          }
      }

      return {
          successCount: reportPaths.length - failures.length,
          failures
      };
  };

  const performArchiveRequests = async (reportPaths: string[]) => {
      const failures: string[] = [];

      for (const reportPath of reportPaths) {
          try {
              const response = await fetch('/api/archive', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ reportPath })
              });

              const data = await response.json();
              if (!response.ok) {
                  throw new Error(data.error || 'Failed to archive report');
              }
          } catch (error: any) {
              failures.push(error.message || 'Failed to archive report');
          }
      }

      return {
          successCount: reportPaths.length - failures.length,
          failures
      };
  };

  const openDeleteModal = (request: DeleteRequest) => {
      deleteRequest = request;
      deleteModalTitle.textContent = request.title;
      deleteModalMessage.textContent = request.message;
      confirmDeleteBtn.textContent = request.confirmLabel;
      deleteModalError.classList.add('hidden');
      deleteModal.classList.remove('hidden');
  };

  // Create highly interactive report row
  const createReportRow = (report: Report, target: SectionKey) => {
      const tr = document.createElement('tr');
      tr.className = 'report-row';
      tr.dataset.path = report.path; // Store path for table-level extraction
      
      const isCurrent = report.path.startsWith('/reports/current/');
      const escapedReportName = (report.name || report.id || '')
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

      tr.addEventListener('click', (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          if (target && target.closest('.btn')) return;
          if (target && target.closest('.btn-open')) return;
          if (target && target.closest('.metadata-input')) return;
          if (target && target.closest('.row-select-control')) return;
          if (target && target.closest('.row-overflow-menu')) return;

          window.open(report.path, '_blank', 'noopener,noreferrer');
      });

      const fixAriaOverflowHtml = isCurrent ? `
        <button class="row-overflow-action overflow-fix-aria" aria-label="Fix Aria Snapshots">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            Fix Snapshots
        </button>
      ` : '';

      const hasVaultFile = vaultFiles.has(report.id);

      // Inline action buttons (visible directly in the row)
      const analysisInlineHtml = hasVaultFile ? `
        <button class="btn-inline-action btn-analysis-inline" aria-label="View Analysis">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            Analysis
        </button>
      ` : '';

      const archiveInlineHtml = isCurrent ? `
        <button class="btn-inline-action btn-archive-inline" aria-label="Archive Report">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="m9 14 3 3 3-3"/></svg>
            Archive
        </button>
      ` : '';

      tr.innerHTML = `
          <td class="col-select">
              <label class="row-select-control" aria-label="Select ${escapedReportName}">
                  <input type="checkbox" class="row-select-checkbox" data-report-path="${report.path}" />
                  <span class="row-select-indicator"></span>
              </label>
          </td>
          <td class="col-date">
              <div class="date-wrapper">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                  <span>${formatDate(report.createdAt)}</span>
              </div>
          </td>
          <td class="col-origin">
              ${isCurrent
                ? `<input type="text" class="origin-input metadata-input" value="${(report.id || '').replace(/"/g, '&quot;')}" placeholder="Rename report..." data-report-id="${report.id}" /><span class="origin-error"></span>`
                                : `<span class="origin-label">${escapedReportName}</span>`
              }
          </td>
          <td class="col-metadata">
              <input type="text" class="metadata-input" value="${(report.metadata || '').replace(/"/g, '&quot;')}" placeholder="Add metadata..." data-report-id="${report.id}" />
          </td>
          <td class="col-action">
              <div class="row-actions">
                  ${analysisInlineHtml}
                  ${archiveInlineHtml}
                  <a href="${report.path}" target="_blank" rel="noopener noreferrer" class="btn-open" aria-label="Open Report">
                      View Report
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                  </a>
                  <div class="row-overflow-menu">
                      <button class="row-overflow-trigger" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">⋯</button>
                      <div class="row-overflow-panel hidden" role="menu">
                          <button class="row-overflow-action overflow-extract" aria-label="Extract Traces">
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="3" rx="1" ry="1"/><path d="M4 11v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="10 15 12 17 14 15"/><line x1="12" x2="12" y1="11" y2="17"/></svg>
                              Extract
                          </button>
                          ${fixAriaOverflowHtml}
                          <div class="row-overflow-divider"></div>
                          <button class="row-overflow-action danger overflow-delete" aria-label="Delete Report" data-date="${formatDate(report.createdAt)}">
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                              Delete
                          </button>
                      </div>
                  </div>
              </div>
              <div class="row-progress-overlay hidden">
                  <div class="spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>
                  <span class="row-progress-text">Working...</span>
              </div>
          </td>
      `;

      const selectCheckbox = tr.querySelector('.row-select-checkbox') as HTMLInputElement;
      if (selectCheckbox) {
          selectCheckbox.addEventListener('click', e => {
              e.stopPropagation();

              const reportPath = selectCheckbox.dataset.reportPath;
              if (!reportPath) return;

              const mouseEvent = e as MouseEvent;
              const anchorPath = lastSelectedReportPath[target];
              const shouldSelectRange = mouseEvent.shiftKey && selectCheckbox.checked && !!anchorPath && anchorPath !== reportPath;

              if (shouldSelectRange) {
                  setRangeSelection(target, anchorPath, reportPath);
              } else {
                  setRowSelection(target, reportPath, selectCheckbox.checked, tr);
              }

              lastSelectedReportPath[target] = reportPath;
          });
      }

      const openLink = tr.querySelector('.btn-open') as HTMLAnchorElement;
      if (openLink) {
          openLink.addEventListener('click', e => e.stopPropagation());
      }

      // Wire up inline analysis button
      const analysisBtn = tr.querySelector('.btn-analysis-inline') as HTMLButtonElement;
      if (analysisBtn) {
          analysisBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              window.open('/vault/' + encodeURIComponent(report.id), '_blank', 'noopener,noreferrer');
          });
      }

      // Wire up inline archive button
      if (isCurrent) {
          const archiveInlineBtn = tr.querySelector('.btn-archive-inline') as HTMLButtonElement;
          if (archiveInlineBtn) {
              archiveInlineBtn.addEventListener('click', async (e) => {
                  e.stopPropagation();
                  await handleArchive(report.path, tr);
              });
          }
      }

      // Wire up overflow menu toggle
      const overflowTrigger = tr.querySelector('.row-overflow-trigger') as HTMLButtonElement;
      const overflowPanel = tr.querySelector('.row-overflow-panel') as HTMLElement;
      if (overflowTrigger && overflowPanel) {
          overflowTrigger.addEventListener('click', (e) => {
              e.stopPropagation();
              const isOpen = !overflowPanel.classList.contains('hidden');
              closeAllOverflowMenus();
              if (!isOpen) {
                  overflowPanel.classList.remove('hidden');
                  overflowTrigger.setAttribute('aria-expanded', 'true');
                  // Position the fixed panel relative to the trigger button
                  const triggerRect = overflowTrigger.getBoundingClientRect();
                  const panelRect = overflowPanel.getBoundingClientRect();
                  const spaceBelow = window.innerHeight - triggerRect.bottom;
                  if (spaceBelow < panelRect.height + 8) {
                      // Flip upward
                      overflowPanel.style.top = '';
                      overflowPanel.style.bottom = (window.innerHeight - triggerRect.top + 6) + 'px';
                  } else {
                      // Open downward
                      overflowPanel.style.bottom = '';
                      overflowPanel.style.top = (triggerRect.bottom + 6) + 'px';
                  }
                  overflowPanel.style.right = (window.innerWidth - triggerRect.right) + 'px';
              }
          });
      }

      // Wire up overflow extract button
      const overflowExtractBtn = tr.querySelector('.overflow-extract') as HTMLButtonElement;
      if (overflowExtractBtn) {
          overflowExtractBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              closeAllOverflowMenus();
              await handleExtract(report.path, tr);
          });
      }

      // Wire up fix aria button conditionally
      if (isCurrent) {
        const fixAriaBtn = tr.querySelector('.overflow-fix-aria') as HTMLButtonElement;
        if (fixAriaBtn) {
            fixAriaBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                closeAllOverflowMenus();
                await handleFixAria(report.path, tr);
            });
        }
      }

      // Wire up delete button
      const deleteBtn = tr.querySelector('.overflow-delete') as HTMLButtonElement;
      if (deleteBtn) {
          deleteBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              closeAllOverflowMenus();
              openDeleteModal({
                  reportPaths: [report.path],
                  title: 'Delete Report',
                  message: `Are you sure that you want to delete report for ${deleteBtn.dataset.date || 'this date'}?`,
                  confirmLabel: 'Delete'
              });
          });
      }

      // Wire up origin rename input (current reports only)
      if (isCurrent) {
          const originInput = tr.querySelector('.origin-input') as HTMLInputElement;
          const originError = tr.querySelector('.origin-error') as HTMLSpanElement;
          if (originInput && originError) {
              let originalOriginValue = originInput.value;
              const FORBIDDEN_ORIGIN = /[\/\\:*?"<>|\x00]/;

              const validateOrigin = (val: string): string => {
                  if (!val.trim()) return 'Name cannot be empty';
                  if (FORBIDDEN_ORIGIN.test(val)) return 'Characters not allowed: / \\ : * ? " < > |';
                  if (val.trim() === '.' || val.trim() === '..') return 'Name is not valid';
                  return '';
              };

              originInput.addEventListener('click', (e) => e.stopPropagation());

              originInput.addEventListener('input', () => {
                  const err = validateOrigin(originInput.value);
                  originError.textContent = err;
                  originInput.classList.toggle('input-error', !!err);
              });

              const saveOriginName = async () => {
                  const newVal = originInput.value.trim();
                  const err = validateOrigin(newVal);
                  if (err) {
                      originError.textContent = err;
                      originInput.classList.add('input-error');
                      return;
                  }
                  if (newVal === originalOriginValue) return;
                  try {
                      const previousPath = report.path;
                      const res = await fetch('/api/report-rename', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ reportId: report.id, newName: newVal })
                      });
                      const data = await res.json();
                      if (!res.ok) {
                          originError.textContent = data.error || 'Rename failed';
                          originInput.classList.add('input-error');
                          originInput.value = originalOriginValue;
                          return;
                      }
                      // Update local state
                      report.id = data.newId;
                      report.name = newVal;
                      report.path = data.newPath;
                      updateCachedRenamedReport(previousPath, data.newId, data.newPath, newVal);
                      lastSelectedReportPath.current = null;
                      originalOriginValue = newVal;
                      originInput.dataset.reportId = data.newId;
                      tr.dataset.path = data.newPath;
                      if (selectCheckbox) {
                          if (selectCheckbox.checked) {
                              selectedReports.current.delete(previousPath);
                              selectedReports.current.add(data.newPath);
                          }
                          selectCheckbox.dataset.reportPath = data.newPath;
                          syncBulkControls('current');
                      }
                      if (openLink) {
                          openLink.href = data.newPath;
                      }
                      // Update metadata input's reportId too
                      const metaInputEl = tr.querySelector('.metadata-input:not(.origin-input)') as HTMLInputElement;
                      if (metaInputEl) metaInputEl.dataset.reportId = data.newId;
                      originError.textContent = '';
                      originInput.classList.remove('input-error');
                  } catch (err) {
                      console.error('Failed to rename report:', err);
                      originError.textContent = 'Rename failed';
                      originInput.classList.add('input-error');
                      originInput.value = originalOriginValue;
                  }
              };

              originInput.addEventListener('keydown', (e) => {
                  if (e.key === 'Enter') { originInput.blur(); }
                  if (e.key === 'Escape') {
                      originInput.value = originalOriginValue;
                      originError.textContent = '';
                      originInput.classList.remove('input-error');
                      originInput.blur();
                  }
              });

              originInput.addEventListener('blur', saveOriginName);
          }
      }

      // Wire up metadata input
      const metaInput = tr.querySelector('.metadata-input:not(.origin-input)') as HTMLInputElement;
      if (metaInput) {
          metaInput.addEventListener('click', (e) => e.stopPropagation());
          
          const saveMetadata = async () => {
              const newVal = metaInput.value.trim();
              try {
                  const res = await fetch('/api/report-metadata', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ reportId: report.id, metadata: newVal })
                  });
                  if (!res.ok) {
                      const d = await res.json();
                      console.error('Failed to save metadata:', d.error);
                      return;
                  }
                  report.metadata = newVal;
                  updateCachedReportMetadata(report.id, newVal);
              } catch (err) {
                  console.error('Failed to save metadata:', err);
              }
          };

          metaInput.addEventListener('blur', saveMetadata);
          metaInput.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                  metaInput.blur();
              }
          });
      }

      return tr;
  };

  // Row progress overlay helpers
  const showRowProgress = (row: HTMLElement, message: string) => {
      const overlay = row.querySelector('.row-progress-overlay') as HTMLElement;
      if (!overlay) return;
      const textEl = overlay.querySelector('.row-progress-text') as HTMLElement;
      if (textEl) textEl.textContent = message;
      overlay.classList.remove('hidden', 'progress-success', 'progress-error');
      overlay.classList.add('progress-active');
  };

  const hideRowProgress = (row: HTMLElement, status: 'success' | 'error', message: string) => {
      const overlay = row.querySelector('.row-progress-overlay') as HTMLElement;
      if (!overlay) return;
      const textEl = overlay.querySelector('.row-progress-text') as HTMLElement;
      if (textEl) textEl.textContent = message;
      overlay.classList.remove('progress-active');
      overlay.classList.add(status === 'success' ? 'progress-success' : 'progress-error');
      setTimeout(() => {
          overlay.classList.add('hidden');
          overlay.classList.remove('progress-success', 'progress-error');
      }, 2000);
  };

  // Logic to handle individual extraction
  const handleExtract = async (reportPath: string, row: HTMLElement) => {
      showRowProgress(row, 'Extracting...');
      try {
          const response = await fetch('/api/extract', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reportPath })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error);
          hideRowProgress(row, 'success', 'Extracted');
      } catch (err: any) {
          console.error("Extraction failed API call:", err);
          hideRowProgress(row, 'error', 'Extraction failed');
      }
  };

  // Logic to handle moving current to archive
  const handleArchive = async (reportPath: string, row: HTMLElement) => {
      showRowProgress(row, 'Archiving...');
      try {
          const response = await fetch('/api/archive', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reportPath })
          });
          const data = await response.json();
          if (!response.ok) {
              if (data.error && data.error.includes("Archive directory is not configured")) {
                 alert("⚠️ " + data.error);
              }
              throw new Error(data.error);
          }
          hideRowProgress(row, 'success', 'Archived');
          setTimeout(() => {
              void reloadVisibleReports();
          }, 800);
      } catch (err: any) {
          console.error("Archive failed API call:", err);
          hideRowProgress(row, 'error', 'Archive failed');
      }
  };
  
  // Logic to handle Aria snapshots extraction
  const handleFixAria = async (reportPath: string, row: HTMLElement) => {
      showRowProgress(row, 'Checking snapshots...');
      try {
          const response = await fetch('/api/aria-snapshots', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reportPath })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error);

          const failures = data.ariaFailures || [];
          if (failures.length === 0) {
              hideRowProgress(row, 'success', 'No failures found');
              return;
          }

          // Hide overlay immediately — we're opening a modal
          const overlay = row.querySelector('.row-progress-overlay') as HTMLElement;
          if (overlay) { overlay.classList.add('hidden'); overlay.classList.remove('progress-active'); }

          // Render failures in modal
          ariaTbody.innerHTML = '';
          failures.forEach((failure: any) => {
              const tr = document.createElement('tr');
              tr.className = 'report-row';
              
              tr.addEventListener('click', () => {
                 openAriaPreviewModal(failure);
              });
              
              tr.innerHTML = `
                  <td style="width: 80%;">
                      <div style="font-weight: 500;">${failure.testTitle}</div>
                      <div style="font-size: 0.8rem; color: var(--text-muted); font-family: monospace; margin-top: 4px;">${failure.file}</div>
                  </td>
                  <td style="width: 20%; text-align: right;">
                      <button class="btn secondary-btn">Preview</button>
                  </td>
              `;
              ariaTbody.appendChild(tr);
          });
          
          ariaModal.classList.remove('hidden');

      } catch (err: any) {
          console.error("Aria extraction failed:", err);
          hideRowProgress(row, 'error', 'Check failed');
      }
  };

  let openAriaPreviewModal = (failure: any) => {
      ariaPreviewSubtitle.textContent = failure.testTitle;
      ariaPreviewBody.innerHTML = '';
      
      failure.snapshots.forEach((snap: any, index: number) => {
         const block = document.createElement('div');
         block.className = 'aria-snapshot-block';
         
         const expectedPathName = snap.expectedPath.split('/').pop() || snap.expectedPath;
         
         const rawNewSnapshot = snap.newSnapshot || '';
         const rawExpectedSnapshot = snap.expectedSnapshot || '';
         const prefixStr = '- /children: deep-equal\n';
         
         // Note: We strip existing prefixes inside computeDiff automatically, but to be clean:
         const newContentBase = rawNewSnapshot.startsWith(prefixStr) ? rawNewSnapshot.substring(prefixStr.length) : rawNewSnapshot;
         
         block.dataset.rawNewSnapshot = newContentBase;
         block.dataset.rawExpectedSnapshot = rawExpectedSnapshot;
         
         block.innerHTML = `
            <div class="aria-snapshot-header">
                <div>
                   <span class="aria-filename">${expectedPathName}</span>
                   <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${snap.expectedPath}</div>
                </div>
                <button class="btn primary-btn apply-aria-fix-btn" data-index="${index}">
                   <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle-2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>
                   Apply Fix
                </button>
            </div>
            <div class="aria-diff-view" id="aria-diff-${index}"></div>
         `;
         ariaPreviewBody.appendChild(block);
         
         const applyBtn = block.querySelector('.apply-aria-fix-btn') as HTMLButtonElement;
         applyBtn.addEventListener('click', async () => {
             const baseStr = block.dataset.rawNewSnapshot || '';
             const newContent = ariaDeepEqualCheckbox.checked ? prefixStr + baseStr : baseStr;
             const originalHtml = applyBtn.innerHTML;
             
             applyBtn.disabled = true;
             applyBtn.innerHTML = `<div class="spinner" style="width: 14px; height: 14px; margin-right: 6px; border-width: 2px; border-top-color: #fff;"></div> Applying...`;
             
             try {
                 const res = await fetch('/api/fix-aria-snapshot', {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({
                         snapshotPath: snap.expectedPath,
                         newContent
                     })
                 });
                 const d = await res.json();
                 
                 if (!res.ok) throw new Error(d.error);
                 
                 applyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg> Fixed`;
                 applyBtn.style.backgroundColor = '#238636';
                 applyBtn.style.borderColor = '#238636';
             } catch(err: any) {
                 console.error("Failed to apply fix", err);
                 applyBtn.innerHTML = `Failed!`;
                 applyBtn.style.backgroundColor = '#f85149';
                 applyBtn.style.borderColor = '#f85149';
             } finally {
                 setTimeout(() => {
                     applyBtn.innerHTML = originalHtml;
                     applyBtn.disabled = false;
                     applyBtn.style.backgroundColor = '';
                     applyBtn.style.borderColor = '';
                 }, 3000);
             }
         });
      });
      
      ariaPreviewModal.classList.remove('hidden');
  };

  closeAriaModalBtn.addEventListener('click', () => ariaModal.classList.add('hidden'));
  closeAriaPreviewBtn.addEventListener('click', () => ariaPreviewModal.classList.add('hidden'));
  closeAriaPreviewFooterBtn.addEventListener('click', () => ariaPreviewModal.classList.add('hidden'));

  const renderAllDiffs = () => {
      const blocks = document.querySelectorAll('.aria-snapshot-block') as NodeListOf<HTMLElement>;
      const isChecked = ariaDeepEqualCheckbox.checked;
      
      blocks.forEach((block, index) => {
          const rawExpected = block.dataset.rawExpectedSnapshot || '';
          const rawNew = block.dataset.rawNewSnapshot || '';
          const diffContainer = document.getElementById(`aria-diff-${index}`);
          if (!diffContainer) return;
          
          const diffLines = computeDiff(normalizeIndent(rawExpected), normalizeIndent(rawNew));
          let html = '';
          
          if (isChecked) {
              html += `<div class="diff-line diff-unchanged">- /children: deep-equal</div>`;
          }
          
          diffLines.forEach(line => {
              const escapedText = line.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              html += `<div class="diff-line diff-${line.type}">${escapedText || ' '}</div>`;
          });
          
          diffContainer.innerHTML = html;
      });
  };

  // Replace openAriaPreviewModal with a wrapped version that calls renderAllDiffs
  const _openAriaPreviewModalOrig = openAriaPreviewModal;
  openAriaPreviewModal = (failure: any) => {
      _openAriaPreviewModalOrig(failure);
      renderAllDiffs();
  };
  
  ariaDeepEqualCheckbox.addEventListener('change', renderAllDiffs);

  const renderTable = (reports: Report[], target: SectionKey) => {
      const context = tableContexts[target];
      const { tbody, section, table } = context;
      tbody.innerHTML = '';
      selectedReports[target].clear();
      if (!reports || reports.length === 0) {
          section.classList.add('hidden');
          syncBulkControls(target);
          return 0;
      }
      
      section.classList.remove('hidden');
      table.classList.remove('hidden');
      reports.forEach(report => tbody.appendChild(createReportRow(report, target)));
      syncBulkControls(target);
      return reports.length;
  };

  const renderReportsData = (data: ReportsResponse, mode: 'default' | 'search') => {
      loading.classList.add('hidden');

      const currentCount = renderTable(data.current, 'current');
      const archiveCount = renderTable(data.archive, 'archive');
      const { configStatus } = data;

      if (mode === 'search') {
          if (currentCount === 0 && archiveCount === 0) {
              emptyState.classList.remove('hidden');
              setEmptyStateContent(
                  'No Matching Reports',
                  'No saved reports matched that metadata and date combination. Adjust the search terms or selected dates and try again.'
              );
          }
          return;
      }

      if (!configStatus || (!configStatus.hasCurrent && !configStatus.hasArchive)) {
          emptyState.classList.remove('hidden');
          setEmptyStateContent('Configuration Required', 'Please open Preferences and configure your report directories to view them here.');
      } else if (currentCount === 0 && archiveCount === 0) {
          emptyState.classList.remove('hidden');
          setEmptyStateContent(
              'No Reports Found',
              'No valid Playwright HTML reports could be found in your configured directories.<br><br>Make sure the selected folders actually contain test runs and the innermost folders contain an <code>index.html</code> right at their root.',
              true
          );
      }
  };

  const fetchVaultFiles = async () => {
      try {
          const response = await fetch('/api/vault/list');
          if (!response.ok) return;
          const data = await response.json();
          vaultFiles = new Set((data.files || []).map((f: { filename: string }) => f.filename));
      } catch {
          vaultFiles = new Set();
      }
  };

  const fetchReports = async (options: { showLoading?: boolean; render?: boolean } = {}) => {
      const { showLoading = true, render = true } = options;
      resetRenderedState(showLoading);

      try {
          await fetchVaultFiles();
          const data = await requestReports('/api/reports');
          cachedReportsData = data;
          if (render) {
              renderReportsData(data, 'default');
          } else {
              loading.classList.add('hidden');
          }
          return data;
      } catch (error: any) {
          console.error('Failed to fetch reports:', error);
          loading.classList.add('hidden');
          if (render) {
              emptyState.classList.remove('hidden');
              setEmptyStateContent('Error loading reports', error.message);
          }
          throw error;
      }
  };

  const fetchAndRenderSearchResults = async (
      filters: SearchFilters,
      options: { showLoading?: boolean; updateAppliedState?: boolean } = {}
  ) => {
      const { showLoading = true } = options;
      const { updateAppliedState = true } = options;
      const normalizedFilters = normalizeSearchFilters(filters);

      resetRenderedState(showLoading);

      try {
          const data = await requestReports(buildSearchUrl(normalizedFilters));
          if (updateAppliedState) {
              setAppliedFilters(normalizedFilters);
          }
          renderReportsData(data, 'search');
          return data;
      } catch (error: any) {
          console.error('Failed to search reports:', error);
          loading.classList.add('hidden');
          emptyState.classList.remove('hidden');
          setEmptyStateContent('Search Unavailable', error.message || 'The report search could not be completed.');
          throw error;
      }
  };

  const searchReportsAndRender = async (options: { showLoading?: boolean } = {}) => {
      const { showLoading = true } = options;
      const filters = readSearchInputs();
      setDraftFilters(filters);

      if (!hasSearchFilters(filters)) {
          setAppliedFilters(null);
          restoreDefaultDashboard();
          return cachedReportsData ?? fetchReports({ showLoading, render: true });
      }

      return fetchAndRenderSearchResults(filters, { showLoading, updateAppliedState: true });
  };

  const restoreDefaultDashboard = () => {
      resetRenderedState(false);
      if (cachedReportsData) {
          renderReportsData(cachedReportsData, 'default');
          return;
      }

      void fetchReports();
  };

  const reloadVisibleReports = async () => {
      const appliedFilters = activeSearchState.applied;
      if (appliedFilters && hasSearchFilters(appliedFilters)) {
          await fetchReports({ showLoading: true, render: false });
          await fetchAndRenderSearchResults(appliedFilters, { showLoading: false, updateAppliedState: false });
          return;
      }

      await fetchReports();
  };

  const openSearchPanel = () => {
      activeSearchState.isOpen = true;
      setDraftFilters(activeSearchState.applied || createEmptySearchFilters());
      searchPanel.classList.remove('hidden');
      updateSearchButtonState();
      window.setTimeout(() => searchInput.focus(), 0);
  };

  const closeSearchPanel = () => {
      activeSearchState.isOpen = false;
      setDraftFilters(activeSearchState.applied || createEmptySearchFilters());
      searchPanel.classList.add('hidden');
      updateSearchButtonState();
  };

  const resetSearchFilters = () => {
      setAppliedFilters(null);
      restoreDefaultDashboard();
      window.setTimeout(() => searchInput.focus(), 0);
  };

  // --- Modal Logic ---

  const openModal = async () => {
      modalError.classList.add('hidden');
      settingsModal.classList.remove('hidden');
      
      try {
          const response = await fetch('/api/config');
          const data = await response.json();
          currentPathInput.value = data.currentPath || '';
          archivePathInput.value = data.archivePath || '';
          projectPathInput.value = data.projectPath || '';
          vaultPathInput.value = data.vaultPath || '';
      } catch (err) {
          console.error("Failed to load config:", err);
      }
  };

  const closeModal = () => {
      settingsModal.classList.add('hidden');
  };

  settingsBtn.addEventListener('click', openModal);
  closeModalBtn.addEventListener('click', closeModal);
  cancelModalBtn.addEventListener('click', closeModal);

  // --- Delete Modal Logic ---
  const closeDeleteModal = () => {
      deleteRequest = null;
      deleteModal.classList.add('hidden');
      deleteModalError.classList.add('hidden');
  };

  closeDeleteModalBtn.addEventListener('click', closeDeleteModal);
  cancelDeleteBtn.addEventListener('click', closeDeleteModal);

  confirmDeleteBtn.addEventListener('click', async () => {
      if (!deleteRequest) return;

      const currentRequest = deleteRequest;

      deleteModalError.classList.add('hidden');
      confirmDeleteBtn.disabled = true;
      confirmDeleteBtn.innerHTML = `<div class="spinner" style="width: 14px; height: 14px; margin-right: 6px; border-width: 2px; border-top-color: #fff;"></div> Deleting...`;

      try {
          const result = await performDeleteRequests(currentRequest.reportPaths);

          if (result.failures.length === currentRequest.reportPaths.length) {
              throw new Error(result.failures[0] || 'Failed to delete reports');
          }

          closeDeleteModal();
          await reloadVisibleReports();

          if (result.failures.length > 0) {
              alert(`Deleted ${result.successCount} reports. Failed to delete ${result.failures.length}. First error: ${result.failures[0]}`);
          }
          
      } catch (err: any) {
          deleteModalError.textContent = err.message;
          deleteModalError.classList.remove('hidden');
      } finally {
          confirmDeleteBtn.disabled = false;
          confirmDeleteBtn.textContent = currentRequest.confirmLabel;
      }
  });

  // Intentionally not closing on backdrop click as requested
  // User must use standard close/cancel/save buttons

  saveModalBtn.addEventListener('click', async () => {
      const currentPath = currentPathInput.value.trim();
      const archivePath = archivePathInput.value.trim();
      const projectPath = projectPathInput.value.trim();
      const vaultPath = vaultPathInput.value.trim();

      modalError.classList.add('hidden');
      saveModalBtn.disabled = true;
      saveModalBtn.textContent = 'Saving...';

      try {
          const response = await fetch('/api/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ currentPath, archivePath, projectPath, vaultPath })
          });
          
          const data = await response.json();
          
          if (!response.ok) {
              throw new Error(data.error || 'Failed to update paths');
          }
          
          closeModal();
          await reloadVisibleReports();
          
      } catch (err: any) {
          modalError.textContent = err.message;
          modalError.classList.remove('hidden');
      } finally {
          saveModalBtn.disabled = false;
          saveModalBtn.textContent = 'Save Changes';
      }
  });

  // --- Toolbars & Globals ---

  (Object.keys(tableContexts) as SectionKey[]).forEach(target => {
      const context = tableContexts[target];

      context.selectAllBtn.addEventListener('click', () => {
          selectAllRows(target);
      });

      context.selectNoneBtn.addEventListener('click', () => {
          clearSelection(target);
      });

      context.bulkMenuTrigger.addEventListener('click', event => {
          event.stopPropagation();
          const isOpen = !context.bulkMenuPanel.classList.contains('hidden');
          closeBulkMenus();
          if (!isOpen && selectedReports[target].size > 0) {
              context.bulkMenuPanel.classList.remove('hidden');
              context.bulkMenuTrigger.setAttribute('aria-expanded', 'true');
          }
      });

      const bulkActions = context.bulkMenuPanel.querySelectorAll<HTMLButtonElement>('.bulk-menu-action');
      bulkActions.forEach(actionBtn => {
          actionBtn.addEventListener('click', async event => {
              event.stopPropagation();

              const action = actionBtn.dataset.action;
              const selectedPaths = Array.from(selectedReports[target]);
              if (selectedPaths.length === 0 || !action) return;

              closeBulkMenus();

              if (action === 'delete') {
                  openDeleteModal({
                      reportPaths: selectedPaths,
                      title: selectedPaths.length === 1 ? 'Delete Report' : 'Delete Selected Reports',
                      message: selectedPaths.length === 1
                          ? `Are you sure that you want to delete the selected ${getTableLabel(target)} report?`
                          : `Are you sure that you want to delete ${selectedPaths.length} selected ${getTableLabel(target)} reports?`,
                      confirmLabel: selectedPaths.length === 1 ? 'Delete' : `Delete ${selectedPaths.length} Reports`
                  });
                  return;
              }

              if (action === 'archive') {
                  const originalText = actionBtn.textContent || 'Archive selected';
                  activeBulkTarget = target;
                  setSelectionControlsDisabled(target, true);
                  actionBtn.textContent = 'Archiving...';

                  try {
                      const result = await performArchiveRequests(selectedPaths);
                      if (result.failures.length === selectedPaths.length) {
                          throw new Error(result.failures[0] || 'Failed to archive reports');
                      }

                      await reloadVisibleReports();

                      if (result.failures.length > 0) {
                          alert(`Archived ${result.successCount} reports. Failed to archive ${result.failures.length}. First error: ${result.failures[0]}`);
                      }
                  } catch (error: any) {
                      alert(error.message || 'Failed to archive reports');
                  } finally {
                      activeBulkTarget = null;
                      actionBtn.textContent = originalText;
                      setSelectionControlsDisabled(target, false);
                      syncBulkControls(target);
                  }
              }
          });
      });
  });

  document.addEventListener('click', event => {
      const target = event.target as HTMLElement;
      if (!target.closest('.bulk-menu')) {
          closeBulkMenus();
      }
      if (!target.closest('.row-overflow-menu')) {
          closeAllOverflowMenus();
      }
  });

  document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
          closeBulkMenus();
          closeAllOverflowMenus();
      }
  });

  searchToggleBtn.addEventListener('click', () => {
      if (activeSearchState.isOpen) {
          searchInput.focus();
          return;
      }
      openSearchPanel();
  });

  searchCloseBtn.addEventListener('click', closeSearchPanel);
  searchSubmitBtn.addEventListener('click', () => {
      void searchReportsAndRender();
  });
  searchResetBtn.addEventListener('click', resetSearchFilters);

  [searchInput, searchRangeStartInput, searchRangeEndInput].forEach(input => {
      input.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
              event.preventDefault();
              void searchReportsAndRender();
          }
      });
  });

  refreshBtn.addEventListener('click', () => {
      const icon = refreshBtn.querySelector('svg') as SVGSVGElement;
      if (icon) {
          icon.style.transition = 'transform 0.5s ease';
          icon.style.transform = `rotate(360deg)`;
      }
      
      reloadVisibleReports().then(() => {
          setTimeout(() => {
              if (icon) {
                  icon.style.transition = 'none';
                  icon.style.transform = `rotate(0deg)`;
              }
          }, 500);
      });
  });

  // Initial fetch
    updateSearchButtonState();
        syncSearchInputs(createEmptySearchFilters());
    syncAllBulkControls();
    fetchReports();
});
