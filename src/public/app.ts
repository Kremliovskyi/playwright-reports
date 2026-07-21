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

type SectionKey = "current" | "archive";

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
  type: "added" | "removed" | "unchanged";
  text: string;
}

function normalizeIndent(str: string): string {
  const normalized = str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const indents = lines
    .filter((l) => l.length > 0 && l.trimStart().length < l.length)
    .map((l) => l.length - l.trimStart().length);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  if (minIndent === 0 || minIndent === 2) return normalized;
  return lines
    .map((l) => {
      if (l.length === 0) return l;
      const spaces = l.length - l.trimStart().length;
      const level = Math.floor(spaces / minIndent);
      return " ".repeat(level * 2) + l.trimStart();
    })
    .join("\n");
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  const newLines = newStr
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const prefix = "- /children: deep-equal";
  const cleanOldLines = oldLines[0] === prefix ? oldLines.slice(1) : oldLines;
  const cleanNewLines = newLines[0] === prefix ? newLines.slice(1) : newLines;

  // A basic Longest Common Subsequence (LCS) algorithm for diffing
  const m = cleanOldLines.length;
  const n = cleanNewLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

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
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (cleanOldLines[i - 1] === cleanNewLines[j - 1]) {
      diff.unshift({ type: "unchanged", text: cleanOldLines[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      diff.unshift({ type: "removed", text: cleanOldLines[i - 1] });
      i--;
    } else {
      diff.unshift({ type: "added", text: cleanNewLines[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    diff.unshift({ type: "removed", text: cleanOldLines[i - 1] });
    i--;
  }
  while (j > 0) {
    diff.unshift({ type: "added", text: cleanNewLines[j - 1] });
    j--;
  }

  return diff;
}

// Maximum number of reports allowed in the archive at once.
const ARCHIVE_LIMIT = 20;
// Minimum number of oldest reports to prune when making room (breathing room).
const MIN_PRUNE = 5;

document.addEventListener("DOMContentLoaded", () => {
  // DOM Elements
  const currentSection = document.getElementById(
    "current-section",
  ) as HTMLElement;
  const currentTable = currentSection.querySelector(
    ".reports-table",
  ) as HTMLElement;
  const currentTbody = document.getElementById("current-tbody") as HTMLElement;

  const archiveSection = document.getElementById(
    "archive-section",
  ) as HTMLElement;
  const archiveTable = archiveSection.querySelector(
    ".reports-table",
  ) as HTMLElement;
  const archiveTbody = document.getElementById("archive-tbody") as HTMLElement;

  const loading = document.getElementById("loading") as HTMLElement;
  const emptyState = document.getElementById("empty-state") as HTMLElement;
  const refreshBtn = document.getElementById(
    "refresh-btn",
  ) as HTMLButtonElement;
  const searchToggleBtn = document.getElementById(
    "search-toggle-btn",
  ) as HTMLButtonElement;
  const searchPanel = document.getElementById("search-panel") as HTMLElement;
  const searchCloseBtn = document.getElementById(
    "search-close-btn",
  ) as HTMLButtonElement;
  const searchInput = document.getElementById(
    "search-input",
  ) as HTMLInputElement;
  const searchSubmitBtn = document.getElementById(
    "search-submit-btn",
  ) as HTMLButtonElement;
  const searchRangeStartInput = document.getElementById(
    "search-range-start",
  ) as HTMLInputElement;
  const searchRangeEndInput = document.getElementById(
    "search-range-end",
  ) as HTMLInputElement;
  const searchResetBtn = document.getElementById(
    "search-reset-btn",
  ) as HTMLButtonElement;

  // Modal Elements
  const settingsBtn = document.getElementById(
    "settings-btn",
  ) as HTMLButtonElement;
  const settingsModal = document.getElementById(
    "settings-modal",
  ) as HTMLElement;
  const closeModalBtn = document.getElementById(
    "close-modal-btn",
  ) as HTMLButtonElement;
  const cancelModalBtn = document.getElementById(
    "cancel-modal-btn",
  ) as HTMLButtonElement;
  const saveModalBtn = document.getElementById(
    "save-modal-btn",
  ) as HTMLButtonElement;

  const currentPathInput = document.getElementById(
    "current-path-input",
  ) as HTMLInputElement;
  const archivePathInput = document.getElementById(
    "archive-path-input",
  ) as HTMLInputElement;
  const projectPathInput = document.getElementById(
    "project-path-input",
  ) as HTMLInputElement;
  const vaultPathInput = document.getElementById(
    "vault-path-input",
  ) as HTMLInputElement;
  const browserstackUsernameInput = document.getElementById(
    "browserstack-username-input",
  ) as HTMLInputElement;
  const browserstackKeyInput = document.getElementById(
    "browserstack-key-input",
  ) as HTMLInputElement;
  const browserstackConfigInput = document.getElementById(
    "browserstack-config-input",
  ) as HTMLInputElement;
  const copilotTokenInput = document.getElementById(
    "copilot-token-input",
  ) as HTMLInputElement;
  const copilotSmallModelField = document.getElementById(
    "copilot-small-model-field",
  ) as HTMLButtonElement;
  const copilotSmallModelValue = document.getElementById(
    "copilot-small-model-value",
  ) as HTMLElement;
  const copilotBigModelField = document.getElementById(
    "copilot-big-model-field",
  ) as HTMLButtonElement;
  const copilotBigModelValue = document.getElementById(
    "copilot-big-model-value",
  ) as HTMLElement;
  const modalError = document.getElementById("modal-error") as HTMLElement;

  const setCopilotModelFieldValue = (role: "small" | "big", model: string) => {
    const field =
      role === "small" ? copilotSmallModelField : copilotBigModelField;
    const value =
      role === "small" ? copilotSmallModelValue : copilotBigModelValue;
    value.textContent = model || "Select a model";
    field.classList.toggle("is-missing", !model);
  };

  // Tab switching in preferences modal
  const modalTabs = settingsModal.querySelectorAll(
    ".modal-tab",
  ) as NodeListOf<HTMLButtonElement>;
  const modalTabContents = settingsModal.querySelectorAll(
    ".modal-tab-content",
  ) as NodeListOf<HTMLElement>;
  modalTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      modalTabs.forEach((t) => t.classList.remove("active"));
      modalTabContents.forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      settingsModal
        .querySelector(`.modal-tab-content[data-tab-content="${target}"]`)
        ?.classList.add("active");
    });
  });

  const deleteModal = document.getElementById("delete-modal") as HTMLElement;
  const deleteModalTitle = document.getElementById(
    "delete-modal-title",
  ) as HTMLElement;
  const deleteModalMessage = document.getElementById(
    "delete-modal-message",
  ) as HTMLElement;
  const closeDeleteModalBtn = document.getElementById(
    "close-delete-modal-btn",
  ) as HTMLButtonElement;
  const cancelDeleteBtn = document.getElementById(
    "cancel-delete-btn",
  ) as HTMLButtonElement;
  const confirmDeleteBtn = document.getElementById(
    "confirm-delete-btn",
  ) as HTMLButtonElement;
  const deleteModalError = document.getElementById(
    "delete-modal-error",
  ) as HTMLElement;

  const archiveLimitModal = document.getElementById(
    "archive-limit-modal",
  ) as HTMLElement;
  const archiveLimitModalTitle = document.getElementById(
    "archive-limit-modal-title",
  ) as HTMLElement;
  const archiveLimitModalMessage = document.getElementById(
    "archive-limit-modal-message",
  ) as HTMLElement;
  const archiveLimitModalHint = document.getElementById(
    "archive-limit-modal-hint",
  ) as HTMLElement;
  const archiveLimitModalError = document.getElementById(
    "archive-limit-modal-error",
  ) as HTMLElement;
  const closeArchiveLimitModalBtn = document.getElementById(
    "close-archive-limit-modal-btn",
  ) as HTMLButtonElement;
  const cancelArchiveLimitBtn = document.getElementById(
    "cancel-archive-limit-btn",
  ) as HTMLButtonElement;
  const confirmArchiveLimitBtn = document.getElementById(
    "confirm-archive-limit-btn",
  ) as HTMLButtonElement;

  const ariaModal = document.getElementById("aria-modal") as HTMLElement;
  const ariaTbody = document.getElementById("aria-tbody") as HTMLElement;
  const closeAriaModalBtn = document.getElementById(
    "close-aria-modal-btn",
  ) as HTMLButtonElement;

  const digestModal = document.getElementById("digest-modal") as HTMLElement;
  const digestTbody = document.getElementById("digest-tbody") as HTMLElement;
  const closeDigestModalBtn = document.getElementById(
    "close-digest-modal-btn",
  ) as HTMLButtonElement;
  const digestSearchInput = document.getElementById(
    "digest-search-input",
  ) as HTMLInputElement;
  const digestSearchBtn = document.getElementById(
    "digest-search-btn",
  ) as HTMLButtonElement;

  let activeDigestRows: { element: HTMLTableRowElement; title: string }[] = [];

  const ariaPreviewModal = document.getElementById(
    "aria-preview-modal",
  ) as HTMLElement;
  const ariaPreviewBody = document.getElementById(
    "aria-preview-body",
  ) as HTMLElement;
  const closeAriaPreviewBtn = document.getElementById(
    "close-aria-preview-btn",
  ) as HTMLButtonElement;
  const closeAriaPreviewFooterBtn = document.getElementById(
    "close-aria-preview-footer-btn",
  ) as HTMLButtonElement;
  const ariaDeepEqualCheckbox = document.getElementById(
    "aria-deep-equal-checkbox",
  ) as HTMLInputElement;
  const ariaPreviewSubtitle = document.getElementById(
    "aria-preview-subtitle",
  ) as HTMLElement;

  const failuresModal = document.getElementById(
    "failures-modal",
  ) as HTMLElement;
  const closeFailuresModalBtn = document.getElementById(
    "close-failures-modal-btn",
  ) as HTMLButtonElement;
  const closeFailuresModalFooterBtn = document.getElementById(
    "close-failures-modal-footer-btn",
  ) as HTMLButtonElement;
  const failuresModalStatusText = document.getElementById(
    "failures-modal-status-text",
  ) as HTMLElement;
  const failuresModalPathValue = document.getElementById(
    "failures-modal-path-value",
  ) as HTMLElement;
  const failuresModalGroupingDiagnostics = document.getElementById(
    "failures-modal-grouping-diagnostics",
  ) as HTMLElement;
  const failuresModalCopyBtn = document.getElementById(
    "failures-modal-copy-btn",
  ) as HTMLButtonElement;
  const failuresModalViewLink = document.getElementById(
    "failures-modal-view-link",
  ) as HTMLAnchorElement;
  const failuresModalGroupedLink = document.getElementById(
    "failures-modal-grouped-link",
  ) as HTMLAnchorElement;
  const activeFailureAnalyses = new Set<string>();

  const reportInfoModal = document.getElementById(
    "report-info-modal",
  ) as HTMLElement;
  const closeReportInfoModalBtn = document.getElementById(
    "close-report-info-modal-btn",
  ) as HTMLButtonElement;
  const closeReportInfoModalFooterBtn = document.getElementById(
    "close-report-info-modal-footer-btn",
  ) as HTMLButtonElement;
  const reportInfoName = document.getElementById(
    "report-info-name",
  ) as HTMLElement;
  const reportInfoSize = document.getElementById(
    "report-info-size",
  ) as HTMLElement;
  const reportInfoRuns = document.getElementById(
    "report-info-runs",
  ) as HTMLElement;
  const reportInfoDigests = document.getElementById(
    "report-info-digests",
  ) as HTMLElement;

  const confirmDeleteModal = document.getElementById(
    "confirm-delete-modal",
  ) as HTMLElement;
  const closeConfirmDeleteModalBtn = document.getElementById(
    "close-confirm-delete-modal-btn",
  ) as HTMLButtonElement;
  const confirmDeleteTitle = document.getElementById(
    "confirm-delete-title",
  ) as HTMLElement;
  const confirmDeleteMessage = document.getElementById(
    "confirm-delete-message",
  ) as HTMLElement;
  const confirmDeletePath = document.getElementById(
    "confirm-delete-path",
  ) as HTMLElement;
  const confirmDeleteCancelBtn = document.getElementById(
    "confirm-delete-cancel-btn",
  ) as HTMLButtonElement;
  const confirmDeleteConfirmBtn = document.getElementById(
    "confirm-delete-confirm-btn",
  ) as HTMLButtonElement;

  const errorModal = document.getElementById("error-modal") as HTMLElement;
  const errorModalTitle = document.getElementById(
    "error-modal-title",
  ) as HTMLElement;
  const errorModalMessage = document.getElementById(
    "error-modal-message",
  ) as HTMLElement;
  const closeErrorModalBtn = document.getElementById(
    "close-error-modal-btn",
  ) as HTMLButtonElement;
  const closeErrorModalFooterBtn = document.getElementById(
    "close-error-modal-footer-btn",
  ) as HTMLButtonElement;

  // Show a blocking error dialog with the full server/exception message (e.g. ENOSPC
  // details that otherwise are only visible in the network tab).
  const showErrorDialog = (title: string, error: unknown) => {
    errorModalTitle.textContent = title;
    errorModalMessage.textContent =
      (error instanceof Error ? error.message : String(error)) ||
      "Unknown error";
    errorModal.classList.remove("hidden");
  };
  closeErrorModalBtn.addEventListener("click", () =>
    errorModal.classList.add("hidden"),
  );
  closeErrorModalFooterBtn.addEventListener("click", () =>
    errorModal.classList.add("hidden"),
  );

  const tableContexts: Record<SectionKey, TableContext> = {
    current: {
      section: currentSection,
      table: currentTable,
      tbody: currentTbody,
      selectAllBtn: document.querySelector(
        '.select-all-btn[data-target="current"]',
      ) as HTMLButtonElement,
      selectNoneBtn: document.querySelector(
        '.select-none-btn[data-target="current"]',
      ) as HTMLButtonElement,
      selectionCount: document.querySelector(
        '.selection-count[data-target="current"]',
      ) as HTMLElement,
      bulkMenu: document.querySelector(
        '.bulk-menu[data-target="current"]',
      ) as HTMLElement,
      bulkMenuTrigger: document.querySelector(
        '.bulk-menu-trigger[data-target="current"]',
      ) as HTMLButtonElement,
      bulkMenuPanel: document.querySelector(
        '.bulk-menu-panel[data-target="current"]',
      ) as HTMLElement,
    },
    archive: {
      section: archiveSection,
      table: archiveTable,
      tbody: archiveTbody,
      selectAllBtn: document.querySelector(
        '.select-all-btn[data-target="archive"]',
      ) as HTMLButtonElement,
      selectNoneBtn: document.querySelector(
        '.select-none-btn[data-target="archive"]',
      ) as HTMLButtonElement,
      selectionCount: document.querySelector(
        '.selection-count[data-target="archive"]',
      ) as HTMLElement,
      bulkMenu: document.querySelector(
        '.bulk-menu[data-target="archive"]',
      ) as HTMLElement,
      bulkMenuTrigger: document.querySelector(
        '.bulk-menu-trigger[data-target="archive"]',
      ) as HTMLButtonElement,
      bulkMenuPanel: document.querySelector(
        '.bulk-menu-panel[data-target="archive"]',
      ) as HTMLElement,
    },
  };

  const selectedReports: Record<SectionKey, Set<string>> = {
    current: new Set<string>(),
    archive: new Set<string>(),
  };

  const lastSelectedReportPath: Record<SectionKey, string | null> = {
    current: null,
    archive: null,
  };

  let deleteRequest: DeleteRequest | null = null;
  let activeBulkTarget: SectionKey | null = null;
  let analysisRunsByReport: Map<
    string,
    { runName: string; mtime: string; runDir: string }[]
  > = new Map();
  let cachedReportsData: ReportsResponse | null = null;
  let activeSearchState: SearchState = {
    isOpen: false,
    draft: {
      query: "",
      rangeStart: "",
      rangeEnd: "",
    },
    applied: null,
  };

  const runTestsBtn = document.getElementById(
    "run-tests-btn",
  ) as HTMLButtonElement;
  const runTestsTooltip = document.getElementById(
    "run-tests-tooltip",
  ) as HTMLDivElement;

  let isProjectPathMissing = true;
  let isRunnerOpen = false;

  const updateRunTestsBtnForProjectPath = (projectPath: string) => {
    isProjectPathMissing = !projectPath;
    if (isProjectPathMissing) {
      runTestsBtn.disabled = true;
      runTestsBtn.style.opacity = "0.7";
      runTestsTooltip?.classList.add("show-tooltip");
    } else {
      runTestsTooltip?.classList.remove("show-tooltip");
      if (!isRunnerOpen) {
        runTestsBtn.disabled = false;
        runTestsBtn.style.opacity = "1";
      }
    }
  };

  if (runTestsBtn) {
    const channel = new BroadcastChannel("runner_state");

    channel.onmessage = (event) => {
      if (event.data.state === "open") {
        isRunnerOpen = true;
        runTestsBtn.disabled = true;
        runTestsBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-terminal"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>
                Runner Active
              `;
        runTestsBtn.style.opacity = "0.7";
      } else if (event.data.state === "closed") {
        isRunnerOpen = false;
        runTestsBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                Run Tests
              `;
        if (!isProjectPathMissing) {
          runTestsBtn.disabled = false;
          runTestsBtn.style.opacity = "1";
        }
      }
    };

    // Ask if runner is already open upon load
    channel.postMessage({ type: "ping" });

    runTestsBtn.addEventListener("click", () => {
      // Temporarily disable to prevent double clicks before tab loads
      runTestsBtn.disabled = true;
      window.open("/runner.html", "_blank", "noopener,noreferrer");
    });

    // Check project path on load to set initial button state
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => updateRunTestsBtnForProjectPath(data.projectPath || ""))
      .catch(() => updateRunTestsBtnForProjectPath(""));

    // Copilot status chip checks access only. Model selection lives in Preferences.
    const copilotChip = document.getElementById(
      "copilot-status-chip",
    ) as HTMLButtonElement | null;
    const copilotChipText = document.getElementById("copilot-status-text");
    const copilotModelsModal = document.getElementById(
      "copilot-models-modal",
    ) as HTMLElement;
    const copilotModelsTitle = document.getElementById(
      "copilot-models-title",
    ) as HTMLElement;
    const copilotModelsHint = document.getElementById(
      "copilot-models-hint",
    ) as HTMLElement;
    const copilotModelsList = document.getElementById(
      "copilot-models-list",
    ) as HTMLElement;
    const closeCopilotModelsBtn = document.getElementById(
      "close-copilot-models-btn",
    ) as HTMLButtonElement;
    const closeCopilotModelsFooterBtn = document.getElementById(
      "close-copilot-models-footer-btn",
    ) as HTMLButtonElement;
    const copilotModelWarningModal = document.getElementById(
      "copilot-model-warning-modal",
    ) as HTMLElement;
    const copilotModelWarningMessage = document.getElementById(
      "copilot-model-warning-message",
    ) as HTMLElement;
    const closeCopilotModelWarningBtn = document.getElementById(
      "close-copilot-model-warning-btn",
    ) as HTMLButtonElement;
    const closeCopilotModelWarningFooterBtn = document.getElementById(
      "close-copilot-model-warning-footer-btn",
    ) as HTMLButtonElement;

    interface CopilotStatus {
      ok: boolean;
      authenticated: boolean;
      login?: string;
      authType?: string;
      error?: string;
    }

    interface CopilotModelsStatus extends CopilotStatus {
      availableModels: string[];
      smallModel: string;
      bigModel: string;
    }

    const COPILOT_MODEL_CHECK_SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check copilot-model-check"><path d="M20 6 9 17l-5-5"/></svg>';

    closeCopilotModelsBtn.addEventListener("click", () =>
      copilotModelsModal.classList.add("hidden"),
    );
    closeCopilotModelsFooterBtn.addEventListener("click", () =>
      copilotModelsModal.classList.add("hidden"),
    );
    closeCopilotModelWarningBtn.addEventListener("click", () =>
      copilotModelWarningModal.classList.add("hidden"),
    );
    closeCopilotModelWarningFooterBtn.addEventListener("click", () =>
      copilotModelWarningModal.classList.add("hidden"),
    );

    const setCopilotChipOk = (status: CopilotStatus) => {
      if (!copilotChip || !copilotChipText) return;
      copilotChip.className = "copilot-status-chip ok";
      copilotChipText.textContent = "Copilot: ready";
      copilotChip.title = `Authenticated as ${status.login || "user"} (${status.authType || "user"}). Click to re-check access.`;
    };

    const saveCopilotModel = async (
      role: "small" | "big",
      model: string,
    ): Promise<boolean> => {
      try {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            role === "small"
              ? { copilotModel: model }
              : { copilotBigModel: model },
          ),
        });
        return res.ok;
      } catch {
        return false;
      }
    };

    const renderCopilotModelsList = (
      status: CopilotModelsStatus,
      role: "small" | "big",
    ) => {
      const selectedModel =
        role === "small" ? status.smallModel : status.bigModel;
      copilotModelsList.innerHTML = "";
      for (const model of status.availableModels) {
        const item = document.createElement("button");
        item.type = "button";
        item.className =
          "copilot-model-item" + (model === selectedModel ? " selected" : "");
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(model === selectedModel));
        const label = document.createElement("span");
        label.textContent = model;
        item.appendChild(label);
        item.insertAdjacentHTML("beforeend", COPILOT_MODEL_CHECK_SVG);
        item.addEventListener("click", async () => {
          const saved = await saveCopilotModel(role, model);
          if (!saved) {
            showErrorDialog(
              "Failed to save model selection",
              `Could not save "${model}" to the configuration. Please try again.`,
            );
            return;
          }
          copilotModelsList
            .querySelectorAll(".copilot-model-item")
            .forEach((el) => {
              el.classList.toggle("selected", el === item);
              el.setAttribute("aria-selected", String(el === item));
            });
          setCopilotModelFieldValue(role, model);
          copilotModelsModal.classList.add("hidden");
        });
        copilotModelsList.appendChild(item);
      }
    };

    let isLoadingCopilotModels = false;

    const openCopilotModelPicker = async (role: "small" | "big") => {
      if (isLoadingCopilotModels) return;
      isLoadingCopilotModels = true;
      const field =
        role === "small" ? copilotSmallModelField : copilotBigModelField;
      const value =
        role === "small" ? copilotSmallModelValue : copilotBigModelValue;
      const previousText = value.textContent || "Select a model";
      field.classList.add("is-loading");
      field.setAttribute("aria-busy", "true");
      value.textContent = "Loading models...";
      copilotSmallModelField.disabled = true;
      copilotBigModelField.disabled = true;
      try {
        const res = await fetch("/api/copilot-models");
        const status: CopilotModelsStatus = await res.json();
        if (!status.ok) {
          showErrorDialog(
            "Copilot models unavailable",
            status.error || "No Copilot models are available.",
          );
          return;
        }
        copilotModelsTitle.textContent =
          role === "small" ? "Select Small Model" : "Select Big Model";
        copilotModelsHint.textContent =
          role === "small"
            ? "This model creates each per-attempt AI record. The selection is saved immediately."
            : "This model groups all AI records into problems. The selection is saved immediately.";
        renderCopilotModelsList(status, role);
        copilotModelsModal.classList.remove("hidden");
      } catch {
        showErrorDialog(
          "Copilot models unavailable",
          "Failed to list Copilot models. Check that the dashboard server is running and try again.",
        );
      } finally {
        value.textContent = previousText;
        field.classList.remove("is-loading");
        field.removeAttribute("aria-busy");
        copilotSmallModelField.disabled = false;
        copilotBigModelField.disabled = false;
        isLoadingCopilotModels = false;
      }
    };

    copilotSmallModelField.addEventListener(
      "click",
      () => void openCopilotModelPicker("small"),
    );
    copilotBigModelField.addEventListener(
      "click",
      () => void openCopilotModelPicker("big"),
    );

    const checkCopilotStatus = async (interactive: boolean) => {
      if (!copilotChip || !copilotChipText) return;
      copilotChip.className = "copilot-status-chip checking";
      copilotChip.title = "Checking Copilot status…";
      copilotChipText.textContent = "Copilot…";
      try {
        const res = await fetch("/api/copilot-status");
        const s: CopilotStatus = await res.json();
        if (!s.ok) {
          copilotChip.className = "copilot-status-chip error";
          copilotChipText.textContent = s.authenticated
            ? "Copilot: error"
            : "Copilot: sign in";
          copilotChip.title =
            (s.error || "Copilot unavailable") + " Click to re-check.";
          if (interactive)
            showErrorDialog(
              "Copilot is not configured",
              s.error || "Copilot unavailable",
            );
          return;
        }
        setCopilotChipOk(s);
      } catch {
        copilotChip.className = "copilot-status-chip error";
        copilotChipText.textContent = "Copilot: error";
        copilotChip.title =
          "Failed to query Copilot status — click to re-check.";
        if (interactive)
          showErrorDialog(
            "Copilot status check failed",
            "Failed to query Copilot status. Check that the dashboard server is running and try again.",
          );
      }
    };
    if (copilotChip) {
      copilotChip.addEventListener(
        "click",
        () => void checkCopilotStatus(true),
      );
      void checkCopilotStatus(false);
    }
  }

  // Format date nicely
  const formatDate = (dateString: string) => {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    };
    return new Date(dateString).toLocaleDateString(undefined, options);
  };

  const setEmptyStateContent = (
    title: string,
    message: string,
    allowHtml: boolean = false,
  ) => {
    const heading = emptyState.querySelector("h3");
    const body = emptyState.querySelector("p");
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
    currentSection.classList.add("hidden");
    archiveSection.classList.add("hidden");
    closeBulkMenus();
    selectedReports.current.clear();
    selectedReports.archive.clear();
    lastSelectedReportPath.current = null;
    lastSelectedReportPath.archive = null;
    emptyState.classList.add("hidden");
    loading.classList.toggle("hidden", !showLoading);
  };

  const createEmptySearchFilters = (): SearchFilters => ({
    query: "",
    rangeStart: "",
    rangeEnd: "",
  });

  const normalizeSearchFilters = (filters: SearchFilters): SearchFilters => ({
    query: filters.query.trim(),
    rangeStart: filters.rangeStart,
    rangeEnd: filters.rangeEnd,
  });

  const readSearchInputs = (): SearchFilters =>
    normalizeSearchFilters({
      query: searchInput.value,
      rangeStart: searchRangeStartInput.value,
      rangeEnd: searchRangeEndInput.value,
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
    refreshBtn.setAttribute("aria-disabled", String(disabled));
    refreshBtn.title = disabled ? "Close search to refresh reports" : "";
  };

  const updateSearchButtonState = () => {
    const hasAppliedFilter = Boolean(
      activeSearchState.applied && hasSearchFilters(activeSearchState.applied),
    );
    searchToggleBtn.classList.toggle(
      "search-toggle-open",
      activeSearchState.isOpen,
    );
    searchToggleBtn.classList.toggle("search-toggle-applied", hasAppliedFilter);
    searchToggleBtn.setAttribute(
      "aria-expanded",
      String(activeSearchState.isOpen),
    );
    setRefreshDisabled(activeSearchState.isOpen);
  };

  const buildSearchUrl = (filters: SearchFilters) => {
    const params = new URLSearchParams();
    if (filters.query) params.set("query", filters.query);
    if (filters.rangeStart) params.set("rangeStart", filters.rangeStart);
    if (filters.rangeEnd) params.set("rangeEnd", filters.rangeEnd);
    const queryString = params.toString();
    return queryString
      ? `/api/report-search?${queryString}`
      : "/api/report-search";
  };

  const setDraftFilters = (filters: SearchFilters) => {
    activeSearchState.draft = normalizeSearchFilters(filters);
    syncSearchInputs(activeSearchState.draft);
  };

  const setAppliedFilters = (filters: SearchFilters | null) => {
    const normalized = filters ? normalizeSearchFilters(filters) : null;
    activeSearchState.applied =
      normalized && hasSearchFilters(normalized) ? normalized : null;
    setDraftFilters(activeSearchState.applied || createEmptySearchFilters());
    updateSearchButtonState();
  };

  const requestReports = async (url: string): Promise<ReportsResponse> => {
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Failed to load reports");
    }
    return data as ReportsResponse;
  };

  const updateCachedReportMetadata = (reportId: string, metadata: string) => {
    if (!cachedReportsData) return;
    [...cachedReportsData.current, ...cachedReportsData.archive].forEach(
      (report) => {
        if (report.id === reportId) {
          report.metadata = metadata;
        }
      },
    );
  };

  const updateCachedRenamedReport = (
    previousPath: string,
    newId: string,
    newPath: string,
    newName: string,
  ) => {
    if (!cachedReportsData) return;
    cachedReportsData.current.forEach((report) => {
      if (report.path === previousPath) {
        report.id = newId;
        report.name = newName;
        report.path = newPath;
      }
    });
  };

  const closeBulkMenus = () => {
    (Object.keys(tableContexts) as SectionKey[]).forEach((target) => {
      const context = tableContexts[target];
      context.bulkMenuPanel.classList.add("hidden");
      context.bulkMenuTrigger.setAttribute("aria-expanded", "false");
    });
  };

  const closeAllOverflowMenus = () => {
    document.querySelectorAll(".row-overflow-panel").forEach((panel) => {
      panel.classList.add("hidden");
    });
    document.querySelectorAll(".row-overflow-trigger").forEach((trigger) => {
      trigger.setAttribute("aria-expanded", "false");
    });
  };

  const closeAllAnalysisMenus = () => {
    document.querySelectorAll(".analysis-menu-panel").forEach((panel) => {
      panel.classList.add("hidden");
    });
    document.querySelectorAll(".btn-analysis-inline").forEach((trigger) => {
      trigger.setAttribute("aria-expanded", "false");
    });
  };

  // Shared right-click context menu for analysis run items ("Copy path").
  let analysisContextPath = "";
  const analysisContextMenu = document.createElement("div");
  analysisContextMenu.className = "analysis-context-menu hidden";
  analysisContextMenu.setAttribute("role", "menu");
  analysisContextMenu.innerHTML = `
      <button class="analysis-context-item" type="button" role="menuitem">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          <span class="analysis-context-label">Copy path</span>
      </button>
  `;
  document.body.appendChild(analysisContextMenu);
  const analysisContextCopyBtn = analysisContextMenu.querySelector(
    ".analysis-context-item",
  ) as HTMLButtonElement;
  const analysisContextLabel = analysisContextMenu.querySelector(
    ".analysis-context-label",
  ) as HTMLElement;

  const hideAnalysisContextMenu = () => {
    analysisContextMenu.classList.add("hidden");
  };

  const showAnalysisContextMenu = (x: number, y: number, pathValue: string) => {
    analysisContextPath = pathValue;
    analysisContextLabel.textContent = "Copy path";
    analysisContextMenu.classList.remove("hidden");
    // Clamp to viewport so the menu stays fully visible.
    const rect = analysisContextMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    analysisContextMenu.style.left = Math.max(8, left) + "px";
    analysisContextMenu.style.top = Math.max(8, top) + "px";
  };

  analysisContextCopyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(analysisContextPath);
      analysisContextLabel.textContent = "Copied!";
      setTimeout(hideAnalysisContextMenu, 700);
    } catch {
      hideAnalysisContextMenu();
    }
  });

  const syncBulkControls = (target: SectionKey) => {
    const context = tableContexts[target];
    const selectionCount = selectedReports[target].size;
    const isBusy = activeBulkTarget === target;

    context.selectionCount.textContent = `${selectionCount} selected`;
    context.selectionCount.classList.toggle("hidden", selectionCount === 0);
    context.selectNoneBtn.disabled = selectionCount === 0 || isBusy;
    context.bulkMenu.classList.toggle("hidden", selectionCount === 0);
    context.bulkMenuTrigger.disabled = selectionCount === 0 || isBusy;

    const menuActions =
      context.bulkMenuPanel.querySelectorAll<HTMLButtonElement>(
        ".bulk-menu-action",
      );
    menuActions.forEach((actionBtn) => {
      actionBtn.disabled = isBusy;
    });

    if (selectionCount === 0 || isBusy) {
      context.bulkMenuPanel.classList.add("hidden");
      context.bulkMenuTrigger.setAttribute("aria-expanded", "false");
    }

    const rows =
      context.tbody.querySelectorAll<HTMLTableRowElement>(".report-row");
    rows.forEach((row) => {
      const checkbox = row.querySelector<HTMLInputElement>(
        ".row-select-checkbox",
      );
      row.classList.toggle("selected", checkbox?.checked ?? false);
    });
  };

  const syncAllBulkControls = () => {
    syncBulkControls("current");
    syncBulkControls("archive");
  };

  const setSelectionControlsDisabled = (
    target: SectionKey,
    disabled: boolean,
  ) => {
    const context = tableContexts[target];
    context.selectAllBtn.disabled = disabled;
    context.selectNoneBtn.disabled =
      disabled || selectedReports[target].size === 0;
    context.bulkMenuTrigger.disabled =
      disabled || selectedReports[target].size === 0;

    const checkboxes = context.tbody.querySelectorAll<HTMLInputElement>(
      ".row-select-checkbox",
    );
    checkboxes.forEach((checkbox) => {
      checkbox.disabled = disabled;
    });

    const actionButtons =
      context.bulkMenuPanel.querySelectorAll<HTMLButtonElement>(
        ".bulk-menu-action",
      );
    actionButtons.forEach((button) => {
      button.disabled = disabled;
    });
  };

  const setRowSelection = (
    target: SectionKey,
    reportPath: string,
    checked: boolean,
    row: HTMLTableRowElement,
  ) => {
    if (checked) {
      selectedReports[target].add(reportPath);
    } else {
      selectedReports[target].delete(reportPath);
    }

    row.classList.toggle("selected", checked);
    syncBulkControls(target);
  };

  const clearSelection = (target: SectionKey) => {
    const context = tableContexts[target];
    selectedReports[target].clear();
    lastSelectedReportPath[target] = null;
    const checkboxes = context.tbody.querySelectorAll<HTMLInputElement>(
      ".row-select-checkbox",
    );
    checkboxes.forEach((checkbox) => {
      checkbox.checked = false;
    });
    syncBulkControls(target);
  };

  const selectAllRows = (target: SectionKey) => {
    const context = tableContexts[target];
    const checkboxes = context.tbody.querySelectorAll<HTMLInputElement>(
      ".row-select-checkbox",
    );
    selectedReports[target].clear();
    lastSelectedReportPath[target] = null;
    checkboxes.forEach((checkbox) => {
      const reportPath = checkbox.dataset.reportPath;
      if (!reportPath) return;
      checkbox.checked = true;
      selectedReports[target].add(reportPath);
    });
    syncBulkControls(target);
  };

  const setRangeSelection = (
    target: SectionKey,
    anchorPath: string,
    currentPath: string,
  ) => {
    const context = tableContexts[target];
    const rows = Array.from(
      context.tbody.querySelectorAll<HTMLTableRowElement>(".report-row"),
    );
    const startIndex = rows.findIndex((row) => row.dataset.path === anchorPath);
    const endIndex = rows.findIndex((row) => row.dataset.path === currentPath);

    if (startIndex === -1 || endIndex === -1) {
      return false;
    }

    const [fromIndex, toIndex] =
      startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];

    for (let index = fromIndex; index <= toIndex; index++) {
      const row = rows[index];
      const checkbox = row.querySelector<HTMLInputElement>(
        ".row-select-checkbox",
      );
      const reportPath = checkbox?.dataset.reportPath;
      if (!checkbox || !reportPath) continue;

      checkbox.checked = true;
      selectedReports[target].add(reportPath);
      row.classList.add("selected");
    }

    syncBulkControls(target);
    return true;
  };

  const getTableLabel = (target: SectionKey) =>
    target === "current" ? "current" : "archived";

  const performDeleteRequests = async (reportPaths: string[]) => {
    const failures: string[] = [];

    for (const reportPath of reportPaths) {
      try {
        const response = await fetch("/api/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportPath }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Failed to delete report");
        }
      } catch (error: any) {
        failures.push(error.message || "Failed to delete report");
      }
    }

    return {
      successCount: reportPaths.length - failures.length,
      failures,
    };
  };

  const performArchiveRequests = async (reportPaths: string[]) => {
    const failures: string[] = [];

    for (const reportPath of reportPaths) {
      try {
        const response = await fetch("/api/archive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportPath }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Failed to archive report");
        }
      } catch (error: any) {
        failures.push(error.message || "Failed to archive report");
      }
    }

    return {
      successCount: reportPaths.length - failures.length,
      failures,
    };
  };

  // Show a blocking info dialog (single Close button) when the requested archive
  // operation can never fit within the limit.
  const showArchiveBlockedDialog = (message: string): Promise<void> => {
    return new Promise((resolve) => {
      archiveLimitModalTitle.textContent = "Archive Limit Reached";
      archiveLimitModalMessage.textContent = message;
      archiveLimitModalHint.classList.add("hidden");
      archiveLimitModalError.classList.add("hidden");
      confirmArchiveLimitBtn.classList.add("hidden");
      cancelArchiveLimitBtn.textContent = "Close";
      archiveLimitModal.classList.remove("hidden");

      const close = () => {
        archiveLimitModal.classList.add("hidden");
        confirmArchiveLimitBtn.classList.remove("hidden");
        cancelArchiveLimitBtn.removeEventListener("click", close);
        closeArchiveLimitModalBtn.removeEventListener("click", close);
        resolve();
      };
      cancelArchiveLimitBtn.addEventListener("click", close);
      closeArchiveLimitModalBtn.addEventListener("click", close);
    });
  };

  // Show the prune-confirmation dialog. On confirm it deletes the supplied oldest
  // archived reports and resolves true; on cancel it resolves false.
  const runArchivePruneDialog = (
    deleteCount: number,
    totalArchived: number,
    oldestPaths: string[],
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      archiveLimitModalTitle.textContent = "Archive Limit Reached";
      archiveLimitModalMessage.textContent =
        `The archive holds ${totalArchived} of a maximum of ${ARCHIVE_LIMIT} reports. ` +
        `Archiving now would exceed the limit. Delete the ${deleteCount} oldest archived ` +
        `report${deleteCount === 1 ? "" : "s"} to make room?`;
      archiveLimitModalHint.textContent =
        "This permanently removes the oldest archived report directories from disk. This cannot be undone.";
      archiveLimitModalHint.classList.remove("hidden");
      archiveLimitModalError.classList.add("hidden");
      confirmArchiveLimitBtn.classList.remove("hidden");
      confirmArchiveLimitBtn.disabled = false;
      confirmArchiveLimitBtn.textContent = `Yes, delete ${deleteCount}`;
      cancelArchiveLimitBtn.textContent = "Cancel";
      archiveLimitModal.classList.remove("hidden");

      const detach = () => {
        confirmArchiveLimitBtn.removeEventListener("click", onConfirm);
        cancelArchiveLimitBtn.removeEventListener("click", onCancel);
        closeArchiveLimitModalBtn.removeEventListener("click", onCancel);
      };

      const onCancel = () => {
        detach();
        archiveLimitModal.classList.add("hidden");
        resolve(false);
      };

      const onConfirm = async () => {
        archiveLimitModalError.classList.add("hidden");
        confirmArchiveLimitBtn.disabled = true;
        confirmArchiveLimitBtn.innerHTML = `<div class="spinner" style="width: 14px; height: 14px; margin-right: 6px; border-width: 2px; border-top-color: #fff;"></div> Deleting...`;
        try {
          const result = await performDeleteRequests(oldestPaths);
          if (result.failures.length === oldestPaths.length) {
            throw new Error(result.failures[0] || "Failed to delete reports");
          }
          detach();
          archiveLimitModal.classList.add("hidden");
          if (result.failures.length > 0) {
            alert(
              `Deleted ${result.successCount} reports. Failed to delete ${result.failures.length}. First error: ${result.failures[0]}`,
            );
          }
          resolve(true);
        } catch (err: any) {
          archiveLimitModalError.textContent =
            err.message || "Failed to delete reports";
          archiveLimitModalError.classList.remove("hidden");
          confirmArchiveLimitBtn.disabled = false;
          confirmArchiveLimitBtn.textContent = `Yes, delete ${deleteCount}`;
        }
      };

      confirmArchiveLimitBtn.addEventListener("click", onConfirm);
      cancelArchiveLimitBtn.addEventListener("click", onCancel);
      closeArchiveLimitModalBtn.addEventListener("click", onCancel);
    });
  };

  // Ensure the archive can accept `incoming` more reports without exceeding the
  // limit. Returns true if archiving may proceed (after any needed pruning),
  // false if the user cancelled or the request is not allowed.
  const ensureArchiveCapacity = async (incoming: number): Promise<boolean> => {
    // Hard cap: a single operation can never exceed the archive limit.
    if (incoming > ARCHIVE_LIMIT) {
      await showArchiveBlockedDialog(
        `You can archive at most ${ARCHIVE_LIMIT} reports at once, because the archive is limited to ${ARCHIVE_LIMIT} reports. Please select fewer reports.`,
      );
      return false;
    }

    // Fetch a fresh archive count at click time.
    let archive: Report[];
    try {
      const data = await requestReports("/api/reports");
      archive = data.archive || [];
    } catch (err: any) {
      alert(err.message || "Failed to check archive size");
      return false;
    }

    const archivedCount = archive.length;
    if (archivedCount + incoming <= ARCHIVE_LIMIT) return true;

    // Delete enough oldest reports to stay within the limit, with a breathing-room floor.
    const deleteCount = Math.min(
      archivedCount,
      Math.max(MIN_PRUNE, archivedCount + incoming - ARCHIVE_LIMIT),
    );
    // Server returns the archive newest-first, so the oldest are at the end.
    const oldestPaths = archive
      .slice(archivedCount - deleteCount)
      .map((report) => report.path);

    return await runArchivePruneDialog(deleteCount, archivedCount, oldestPaths);
  };

  const openDeleteModal = (request: DeleteRequest) => {
    deleteRequest = request;
    deleteModalTitle.textContent = request.title;
    deleteModalMessage.textContent = request.message;
    confirmDeleteBtn.textContent = request.confirmLabel;
    deleteModalError.classList.add("hidden");
    deleteModal.classList.remove("hidden");
  };

  // Create highly interactive report row
  const createReportRow = (report: Report, target: SectionKey) => {
    const tr = document.createElement("tr");
    tr.className = "report-row";
    tr.dataset.path = report.path; // Store path for table-level extraction

    const isCurrent = report.path.startsWith("/reports/current/");
    const escapedReportName = (report.name || report.id || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const fixAriaOverflowHtml = isCurrent
      ? `
        <button class="row-overflow-action overflow-fix-aria" aria-label="Fix Aria Snapshots">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            Fix Snapshots
        </button>
      `
      : "";

    const failuresOverflowHtml = isCurrent
      ? `
        <button class="row-overflow-action overflow-failures" aria-label="Analyze Failures">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
            Analyze Failures
        </button>
      `
      : "";

    const digestOverflowHtml = `
        <button class="row-overflow-action overflow-digest" aria-label="Digest Traces">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-activity"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            Digest
        </button>
      `;

    const analysisRuns = analysisRunsByReport.get(report.id) || [];
    const analysisCount = analysisRuns.length;
    const safeReportId = (report.id || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Inline "Info" button — always visible; opens the Report Info dialog.
    const analysisInlineHtml = `
        <button class="btn-inline-action btn-info-inline" aria-label="Report Info" data-report-id="${safeReportId}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            Info${analysisCount > 0 ? ` (${analysisCount})` : ""}
        </button>
      `;

    const archiveInlineHtml = isCurrent
      ? `
        <button class="btn-inline-action btn-archive-inline" aria-label="Archive Report">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="m9 14 3 3 3-3"/></svg>
            Archive
        </button>
      `
      : "";

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
              ${
                isCurrent
                  ? `<input type="text" class="origin-input metadata-input" value="${(report.id || "").replace(/"/g, "&quot;")}" placeholder="Rename report..." data-report-id="${report.id}" /><span class="origin-error"></span>`
                  : `<span class="origin-label">${escapedReportName}</span>`
              }
          </td>
          <td class="col-metadata">
              <input type="text" class="metadata-input" value="${(report.metadata || "").replace(/"/g, "&quot;")}" placeholder="Add metadata..." data-report-id="${report.id}" />
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
                          ${failuresOverflowHtml}
                          ${digestOverflowHtml}
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

    const selectCheckbox = tr.querySelector(
      ".row-select-checkbox",
    ) as HTMLInputElement;
    if (selectCheckbox) {
      selectCheckbox.addEventListener("click", (e) => {
        e.stopPropagation();

        const reportPath = selectCheckbox.dataset.reportPath;
        if (!reportPath) return;

        const mouseEvent = e as MouseEvent;
        const anchorPath = lastSelectedReportPath[target];
        const shouldSelectRange =
          mouseEvent.shiftKey &&
          selectCheckbox.checked &&
          !!anchorPath &&
          anchorPath !== reportPath;

        if (shouldSelectRange) {
          setRangeSelection(target, anchorPath, reportPath);
        } else {
          setRowSelection(target, reportPath, selectCheckbox.checked, tr);
        }

        lastSelectedReportPath[target] = reportPath;
      });
    }

    const openLink = tr.querySelector(".btn-open") as HTMLAnchorElement;
    if (openLink) {
      openLink.addEventListener("click", (e) => e.stopPropagation());
    }

    // Wire up inline "Info" button — opens the Report Info dialog.
    const infoBtn = tr.querySelector(".btn-info-inline") as HTMLButtonElement;
    if (infoBtn) {
      infoBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllOverflowMenus();
        hideAnalysisContextMenu();
        openReportInfoModal(report.id);
      });
    }

    // Wire up inline archive button
    if (isCurrent) {
      const archiveInlineBtn = tr.querySelector(
        ".btn-archive-inline",
      ) as HTMLButtonElement;
      if (archiveInlineBtn) {
        archiveInlineBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await handleArchive(report.path, tr);
        });
      }
    }

    // Wire up overflow menu toggle
    const overflowTrigger = tr.querySelector(
      ".row-overflow-trigger",
    ) as HTMLButtonElement;
    const overflowPanel = tr.querySelector(
      ".row-overflow-panel",
    ) as HTMLElement;
    if (overflowTrigger && overflowPanel) {
      overflowTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = !overflowPanel.classList.contains("hidden");
        closeAllOverflowMenus();
        if (!isOpen) {
          overflowPanel.classList.remove("hidden");
          overflowTrigger.setAttribute("aria-expanded", "true");
          // Position the fixed panel relative to the trigger button
          const triggerRect = overflowTrigger.getBoundingClientRect();
          const panelRect = overflowPanel.getBoundingClientRect();
          const spaceBelow = window.innerHeight - triggerRect.bottom;
          if (spaceBelow < panelRect.height + 8) {
            // Flip upward
            overflowPanel.style.top = "";
            overflowPanel.style.bottom =
              window.innerHeight - triggerRect.top + 6 + "px";
          } else {
            // Open downward
            overflowPanel.style.bottom = "";
            overflowPanel.style.top = triggerRect.bottom + 6 + "px";
          }
          overflowPanel.style.right =
            window.innerWidth - triggerRect.right + "px";
        }
      });
    }

    // Wire up overflow extract button
    const overflowExtractBtn = tr.querySelector(
      ".overflow-extract",
    ) as HTMLButtonElement;
    if (overflowExtractBtn) {
      overflowExtractBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        closeAllOverflowMenus();
        await handleExtract(report.path, tr);
      });
    }

    // Wire up fix aria button conditionally
    if (isCurrent) {
      const fixAriaBtn = tr.querySelector(
        ".overflow-fix-aria",
      ) as HTMLButtonElement;
      if (fixAriaBtn) {
        fixAriaBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          closeAllOverflowMenus();
          await handleFixAria(report.path, tr);
        });
      }
    }

    // Wire up analyze failures button conditionally
    if (isCurrent) {
      const failuresBtn = tr.querySelector(
        ".overflow-failures",
      ) as HTMLButtonElement;
      if (failuresBtn) {
        failuresBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          closeAllOverflowMenus();
          await handleFailures(report.path, tr);
        });
      }
    }

    // Wire up digest button
    const digestBtn = tr.querySelector(".overflow-digest") as HTMLButtonElement;
    if (digestBtn) {
      digestBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        closeAllOverflowMenus();
        await handleDigest(report.path, tr);
      });
    }

    // Wire up delete button
    const deleteBtn = tr.querySelector(".overflow-delete") as HTMLButtonElement;
    if (deleteBtn) {
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllOverflowMenus();
        openDeleteModal({
          reportPaths: [report.path],
          title: "Delete Report",
          message: `Are you sure that you want to delete report for ${deleteBtn.dataset.date || "this date"}?`,
          confirmLabel: "Delete",
        });
      });
    }

    // Wire up origin rename input (current reports only)
    if (isCurrent) {
      const originInput = tr.querySelector(".origin-input") as HTMLInputElement;
      const originError = tr.querySelector(".origin-error") as HTMLSpanElement;
      if (originInput && originError) {
        let originalOriginValue = originInput.value;
        const FORBIDDEN_ORIGIN = /[\/\\:*?"<>|\x00]/;

        const validateOrigin = (val: string): string => {
          if (!val.trim()) return "Name cannot be empty";
          if (FORBIDDEN_ORIGIN.test(val))
            return 'Characters not allowed: / \\ : * ? " < > |';
          if (val.trim() === "." || val.trim() === "..")
            return "Name is not valid";
          return "";
        };

        originInput.addEventListener("click", (e) => e.stopPropagation());

        originInput.addEventListener("input", () => {
          const err = validateOrigin(originInput.value);
          originError.textContent = err;
          originInput.classList.toggle("input-error", !!err);
        });

        const saveOriginName = async () => {
          const newVal = originInput.value.trim();
          const err = validateOrigin(newVal);
          if (err) {
            originError.textContent = err;
            originInput.classList.add("input-error");
            return;
          }
          if (newVal === originalOriginValue) return;
          try {
            const previousPath = report.path;
            const res = await fetch("/api/report-rename", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reportId: report.id, newName: newVal }),
            });
            const data = await res.json();
            if (!res.ok) {
              originError.textContent = data.error || "Rename failed";
              originInput.classList.add("input-error");
              originInput.value = originalOriginValue;
              return;
            }
            // Update local state
            report.id = data.newId;
            report.name = newVal;
            report.path = data.newPath;
            updateCachedRenamedReport(
              previousPath,
              data.newId,
              data.newPath,
              newVal,
            );
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
              syncBulkControls("current");
            }
            if (openLink) {
              openLink.href = data.newPath;
            }
            // Update metadata input's reportId too
            const metaInputEl = tr.querySelector(
              ".metadata-input:not(.origin-input)",
            ) as HTMLInputElement;
            if (metaInputEl) metaInputEl.dataset.reportId = data.newId;
            originError.textContent = "";
            originInput.classList.remove("input-error");
          } catch (err) {
            console.error("Failed to rename report:", err);
            originError.textContent = "Rename failed";
            originInput.classList.add("input-error");
            originInput.value = originalOriginValue;
          }
        };

        originInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            originInput.blur();
          }
          if (e.key === "Escape") {
            originInput.value = originalOriginValue;
            originError.textContent = "";
            originInput.classList.remove("input-error");
            originInput.blur();
          }
        });

        originInput.addEventListener("blur", saveOriginName);
      }
    }

    // Wire up metadata input
    const metaInput = tr.querySelector(
      ".metadata-input:not(.origin-input)",
    ) as HTMLInputElement;
    if (metaInput) {
      metaInput.addEventListener("click", (e) => e.stopPropagation());

      const saveMetadata = async () => {
        const newVal = metaInput.value.trim();
        try {
          const res = await fetch("/api/report-metadata", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reportId: report.id, metadata: newVal }),
          });
          if (!res.ok) {
            const d = await res.json();
            console.error("Failed to save metadata:", d.error);
            return;
          }
          report.metadata = newVal;
          updateCachedReportMetadata(report.id, newVal);
        } catch (err) {
          console.error("Failed to save metadata:", err);
        }
      };

      metaInput.addEventListener("blur", saveMetadata);
      metaInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          metaInput.blur();
        }
      });
    }

    return tr;
  };

  // Row progress overlay helpers
  const showRowProgress = (row: HTMLElement, message: string) => {
    const overlay = row.querySelector(".row-progress-overlay") as HTMLElement;
    if (!overlay) return;
    const textEl = overlay.querySelector(".row-progress-text") as HTMLElement;
    if (textEl) textEl.textContent = message;
    overlay.classList.remove("hidden", "progress-success", "progress-error");
    overlay.classList.add("progress-active");
  };

  const hideRowProgress = (
    row: HTMLElement,
    status: "success" | "error",
    message: string,
  ) => {
    const overlay = row.querySelector(".row-progress-overlay") as HTMLElement;
    if (!overlay) return;
    const textEl = overlay.querySelector(".row-progress-text") as HTMLElement;
    if (textEl) textEl.textContent = message;
    overlay.classList.remove("progress-active");
    overlay.classList.add(
      status === "success" ? "progress-success" : "progress-error",
    );
    setTimeout(() => {
      overlay.classList.add("hidden");
      overlay.classList.remove("progress-success", "progress-error");
    }, 2000);
  };

  // Logic to handle individual extraction
  const handleExtract = async (reportPath: string, row: HTMLElement) => {
    showRowProgress(row, "Extracting...");
    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportPath }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      hideRowProgress(row, "success", "Extracted");
    } catch (err: any) {
      console.error("Extraction failed API call:", err);
      hideRowProgress(row, "error", "Extraction failed");
      showErrorDialog("Extraction failed", err);
    }
  };

  // Logic to handle failure analysis (playwright-traces-reader `failures` + Copilot SDK per-trace records)
  const handleFailures = async (reportPath: string, row: HTMLElement) => {
    if (activeFailureAnalyses.has(reportPath)) return;
    activeFailureAnalyses.add(reportPath);
    showRowProgress(row, "Checking Copilot...");

    // Subscribe to per-trace AI analysis progress over SSE.
    let aiEvents: EventSource | null = null;
    try {
      aiEvents = new EventSource("/api/logs");
      aiEvents.addEventListener("failure-analysis", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data);
          if (p.phase === "digest") {
            showRowProgress(row, "Digesting failures...");
          } else if (p.phase === "start") {
            showRowProgress(
              row,
              p.total > 0 ? `Analyzing 0/${p.total}...` : "Analyzing...",
            );
          } else if (
            p.phase === "progress" &&
            typeof p.completed === "number"
          ) {
            showRowProgress(row, `Analyzing ${p.completed}/${p.total}...`);
          } else if (p.phase === "complete") {
            showRowProgress(row, "Finalizing...");
          } else if (p.phase === "grouping-start") {
            showRowProgress(row, "Grouping problems...");
          } else if (p.phase === "grouping-complete") {
            showRowProgress(row, "Finalizing grouped analysis...");
          } else if (p.phase === "grouping-failed") {
            showRowProgress(row, "Finalizing with grouping warning...");
          }
        } catch {
          /* ignore malformed event */
        }
      });
    } catch {
      /* SSE is optional progress sugar */
    }

    try {
      const response = await fetch("/api/failures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportPath }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.code === "FAILURE_ANALYSIS_IN_PROGRESS") {
          hideRowProgress(row, "error", "Analysis already running");
          return;
        }
        if (data.code === "COPILOT_MODEL_UNAVAILABLE") {
          hideRowProgress(
            row,
            "error",
            `Select ${data.modelRole || "a"} model`,
          );
          const warningModal = document.getElementById(
            "copilot-model-warning-modal",
          );
          const warningMessage = document.getElementById(
            "copilot-model-warning-message",
          );
          if (warningModal && warningMessage) {
            warningMessage.textContent =
              data.error ||
              "A saved Copilot model is not available. Select another model in Preferences > Copilot.";
            warningModal.classList.remove("hidden");
          }
          return;
        }
        throw new Error(data.error || "Failure analysis failed");
      }
      const count = data.count ?? 0;
      const label =
        count === 0
          ? "No failures"
          : `${count} failure${count === 1 ? "" : "s"}`;
      hideRowProgress(row, "success", label);

      // Populate and open the failures modal, including AI record outcome.
      let statusText = `Analyzed failures successfully! ${count === 0 ? "No failures" : `${count} failure${count === 1 ? "" : "s"} found.`}`;
      if (data.ai) {
        statusText +=
          ` AI records: ${data.ai.analyzed} written` +
          (data.ai.failed ? `, ${data.ai.failed} failed` : "") +
          (data.ai.skipped ? `, ${data.ai.skipped} skipped` : "") +
          ".";
      } else if (data.aiError) {
        statusText += ` AI analysis skipped: ${data.aiError}`;
      }
      if (data.grouping) {
        statusText += ` Grouped into ${data.grouping.problemCount} problem${data.grouping.problemCount === 1 ? "" : "s"}.`;
      } else if (data.groupingError) {
        statusText += ` Problem grouping failed: ${data.groupingError}`;
      }
      failuresModalStatusText.textContent = statusText;
      failuresModalPathValue.textContent = data.relativeRunDir || "";
      const diagnostics = data.groupingDiagnostics;
      if (diagnostics) {
        const formatBytes = (bytes: number) =>
          bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
        const formatTokens = (tokens: number | undefined) =>
          typeof tokens === "number" ? tokens.toLocaleString() : "not reported";
        const lines = [
          `Grouping ${diagnostics.stage === "complete" ? "completed" : `failed at ${diagnostics.stage}`}`,
          `${diagnostics.model} · ${diagnostics.reasoningEffort} reasoning · ${diagnostics.contextTier} context`,
          `${diagnostics.attemptCount} attempts · ${diagnostics.issueCount} issues · ${diagnostics.requestCount} model request${diagnostics.requestCount === 1 ? "" : "s"}`,
          `${formatBytes(diagnostics.promptBytes)} total prompt · ${formatBytes(diagnostics.responseBytes)} total response`,
          `${formatTokens(diagnostics.inputTokens)} input tokens · ${formatTokens(diagnostics.outputTokens)} output tokens`,
          `Context ${formatTokens(diagnostics.contextTokens)} / ${formatTokens(diagnostics.contextTokenLimit)} tokens · ${(diagnostics.durationMs / 1000).toFixed(1)}s elapsed · ${(diagnostics.timeoutMs / 1000).toFixed(0)}s per-request timeout`,
        ];
        if (diagnostics.repairAttempted) {
          const repaired =
            diagnostics.omittedIssueCountBeforeRepair -
            diagnostics.omittedIssueCountAfterRepair;
          if (diagnostics.repairErrorMessage) {
            lines.push(
              `Repair failed: ${diagnostics.repairErrorMessage} · ${diagnostics.omittedIssueCountAfterRepair} issue${diagnostics.omittedIssueCountAfterRepair === 1 ? "" : "s"} left unclassified`,
            );
          } else {
            lines.push(
              `Repair resolved ${repaired}/${diagnostics.omittedIssueCountBeforeRepair} omitted issues · ${diagnostics.omittedIssueCountAfterRepair} left unclassified`,
            );
          }
        }
        if (diagnostics.finishReason)
          lines.push(`Finish reason: ${diagnostics.finishReason}`);
        if (diagnostics.truncationCount || diagnostics.compactionCount) {
          lines.push(
            `Truncations: ${diagnostics.truncationCount} · Compactions: ${diagnostics.compactionCount}`,
          );
        }
        if (diagnostics.errorMessage) {
          lines.push(
            `Error${diagnostics.errorType ? ` (${diagnostics.errorType})` : ""}: ${diagnostics.errorMessage}`,
          );
        }
        failuresModalGroupingDiagnostics.textContent = lines.join("\n");
        failuresModalGroupingDiagnostics.classList.remove("hidden");
      } else {
        failuresModalGroupingDiagnostics.textContent = "";
        failuresModalGroupingDiagnostics.classList.add("hidden");
      }
      failuresModalViewLink.href = data.failuresUrl || "#";
      failuresModalGroupedLink.classList.toggle("hidden", !data.grouping?.url);
      failuresModalGroupedLink.href = data.grouping?.url || "#";
      failuresModal.classList.remove("hidden");
    } catch (err: any) {
      console.error("Failure analysis API call:", err);
      hideRowProgress(row, "error", "Analysis failed");
      showErrorDialog("Failure analysis failed", err);
    } finally {
      if (aiEvents) aiEvents.close();
      activeFailureAnalyses.delete(reportPath);
    }
  };

  // Logic to handle moving current to archive
  const handleArchive = async (reportPath: string, row: HTMLElement) => {
    if (!(await ensureArchiveCapacity(1))) {
      return;
    }
    showRowProgress(row, "Archiving...");
    try {
      const response = await fetch("/api/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportPath }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      hideRowProgress(row, "success", "Archived");
      setTimeout(() => {
        void reloadVisibleReports();
      }, 800);
    } catch (err: any) {
      console.error("Archive failed API call:", err);
      hideRowProgress(row, "error", "Archive failed");
      showErrorDialog("Archive failed", err);
    }
  };

  // Logic to handle Aria snapshots extraction
  const handleFixAria = async (reportPath: string, row: HTMLElement) => {
    showRowProgress(row, "Checking snapshots...");
    try {
      const response = await fetch("/api/aria-snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportPath }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      const failures = data.ariaFailures || [];
      if (failures.length === 0) {
        hideRowProgress(row, "success", "No failures found");
        return;
      }

      // Hide overlay immediately — we're opening a modal
      const overlay = row.querySelector(".row-progress-overlay") as HTMLElement;
      if (overlay) {
        overlay.classList.add("hidden");
        overlay.classList.remove("progress-active");
      }

      // Render failures in modal
      ariaTbody.innerHTML = "";
      failures.forEach((failure: any) => {
        const tr = document.createElement("tr");
        tr.className = "report-row";

        tr.addEventListener("click", () => {
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

      ariaModal.classList.remove("hidden");
    } catch (err: any) {
      console.error("Aria extraction failed:", err);
      hideRowProgress(row, "error", "Check failed");
      showErrorDialog("Aria snapshot check failed", err);
    }
  };

  let openAriaPreviewModal = (failure: any) => {
    ariaPreviewSubtitle.textContent = failure.testTitle;
    ariaPreviewBody.innerHTML = "";

    failure.snapshots.forEach((snap: any, index: number) => {
      const block = document.createElement("div");
      block.className = "aria-snapshot-block";

      const expectedPathName =
        snap.expectedPath.split("/").pop() || snap.expectedPath;

      const rawNewSnapshot = snap.newSnapshot || "";
      const rawExpectedSnapshot = snap.expectedSnapshot || "";
      const prefixStr = "- /children: deep-equal\n";

      // Note: We strip existing prefixes inside computeDiff automatically, but to be clean:
      const newContentBase = rawNewSnapshot.startsWith(prefixStr)
        ? rawNewSnapshot.substring(prefixStr.length)
        : rawNewSnapshot;

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

      const applyBtn = block.querySelector(
        ".apply-aria-fix-btn",
      ) as HTMLButtonElement;
      applyBtn.addEventListener("click", async () => {
        const baseStr = block.dataset.rawNewSnapshot || "";
        const newContent = ariaDeepEqualCheckbox.checked
          ? prefixStr + baseStr
          : baseStr;
        const originalHtml = applyBtn.innerHTML;

        applyBtn.disabled = true;
        applyBtn.innerHTML = `<div class="spinner" style="width: 14px; height: 14px; margin-right: 6px; border-width: 2px; border-top-color: #fff;"></div> Applying...`;

        try {
          const res = await fetch("/api/fix-aria-snapshot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              snapshotPath: snap.expectedPath,
              newContent,
            }),
          });
          const d = await res.json();

          if (!res.ok) throw new Error(d.error);

          applyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg> Fixed`;
          applyBtn.style.backgroundColor = "#238636";
          applyBtn.style.borderColor = "#238636";
        } catch (err: any) {
          console.error("Failed to apply fix", err);
          applyBtn.innerHTML = `Failed!`;
          applyBtn.style.backgroundColor = "#f85149";
          applyBtn.style.borderColor = "#f85149";
        } finally {
          setTimeout(() => {
            applyBtn.innerHTML = originalHtml;
            applyBtn.disabled = false;
            applyBtn.style.backgroundColor = "";
            applyBtn.style.borderColor = "";
          }, 3000);
        }
      });
    });

    ariaPreviewModal.classList.remove("hidden");
  };

  closeAriaModalBtn.addEventListener("click", () =>
    ariaModal.classList.add("hidden"),
  );
  closeAriaPreviewBtn.addEventListener("click", () =>
    ariaPreviewModal.classList.add("hidden"),
  );
  closeAriaPreviewFooterBtn.addEventListener("click", () =>
    ariaPreviewModal.classList.add("hidden"),
  );
  closeDigestModalBtn.addEventListener("click", () =>
    digestModal.classList.add("hidden"),
  );

  closeFailuresModalBtn.addEventListener("click", () =>
    failuresModal.classList.add("hidden"),
  );
  closeFailuresModalFooterBtn.addEventListener("click", () =>
    failuresModal.classList.add("hidden"),
  );
  failuresModalCopyBtn.addEventListener("click", async () => {
    const pathText = failuresModalPathValue.textContent || "";
    try {
      await navigator.clipboard.writeText(pathText);
      const originalCopyHtml = failuresModalCopyBtn.innerHTML;
      failuresModalCopyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg> Copied!`;
      setTimeout(() => {
        failuresModalCopyBtn.innerHTML = originalCopyHtml;
      }, 2000);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  });

  // ----- Report Info dialog -----
  interface ReportInfoRun {
    runName: string;
    createdAt: string;
    runDir: string;
    runDirExists: boolean;
    analysisFile: string;
    analysisFileExists: boolean;
    groupedAnalysisFile: string;
    groupedAnalysisExists: boolean;
    groupedAnalysisUrl: string | null;
    failuresUrl: string | null;
    vaultUrl: string;
  }
  interface ReportInfoResponse {
    reportId: string;
    folder: string;
    folderExists: boolean;
    runs: ReportInfoRun[];
    digests: ReportInfoDigest[];
  }
  interface ReportInfoDigest {
    id: string;
    testTitle: string;
    createdAt: string;
    digestDir: string;
    digestDirExists: boolean;
    digestUrl: string | null;
  }

  let reportInfoCurrentReportId = "";
  // Report-folder sizes are cached client-side; they only change on extract/archive/rename, none of
  // which happen while the dialog is open, so a cached value stays valid across reopens.
  const reportSizeCache = new Map<string, number>();

  const escHtml = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
  };

  const copyIcon =
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const openIcon =
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>';
  const trashIcon =
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

  const renderReportInfoPathRow = (
    kind: "output" | "analysis" | "grouped",
    runName: string,
    label: string,
    pathValue: string,
    exists: boolean,
    openUrl: string | null,
    emptyText: string,
  ): string => {
    const safeRun = escHtml(runName);
    if (!pathValue) {
      return `
        <div class="report-info-path-row">
          <span class="report-info-path-label">${label}</span>
          <code class="report-info-path is-empty">${emptyText}</code>
        </div>`;
    }
    const safePath = escHtml(pathValue);
    const missingBadge = exists
      ? ""
      : ' <span class="report-info-missing">(missing on disk)</span>';
    const openBtn = openUrl
      ? `<a class="report-info-path-action" href="${escHtml(openUrl)}" target="_blank" rel="noopener noreferrer" title="Open">${openIcon}</a>`
      : "";
    const deleteBtn =
      kind === "grouped"
        ? ""
        : `<button class="report-info-path-action danger" type="button" data-action="delete-${kind}" data-run="${safeRun}" data-path="${safePath}" title="Delete">${trashIcon}</button>`;
    return `
        <div class="report-info-path-row">
          <span class="report-info-path-label">${label}</span>
          <code class="report-info-path" data-copy="${safePath}">${safePath}${missingBadge}</code>
          <div class="report-info-path-actions">
            <button class="report-info-path-action" type="button" data-action="copy" data-path="${safePath}" title="Copy path">${copyIcon}</button>
            ${openBtn}
            ${deleteBtn}
          </div>
        </div>`;
  };

  const renderReportInfo = (info: ReportInfoResponse): void => {
    reportInfoName.textContent = info.reportId;
    const runs = info.runs || [];
    if (runs.length === 0) {
      reportInfoRuns.innerHTML =
        '<div class="report-info-empty">No analysis runs for this report yet.</div>';
    } else {
      reportInfoRuns.innerHTML = runs
        .map((run) => {
          const outputRow = renderReportInfoPathRow(
            "output",
            run.runName,
            "Output dir",
            run.runDir,
            run.runDirExists,
            run.failuresUrl,
            "— removed",
          );
          const groupedRow = renderReportInfoPathRow(
            "grouped",
            run.runName,
            "Grouped analysis",
            run.groupedAnalysisFile,
            run.groupedAnalysisExists,
            run.groupedAnalysisUrl,
            "No grouped analysis",
          );
          const analysisRow = renderReportInfoPathRow(
            "analysis",
            run.runName,
            "Analysis file",
            run.analysisFile,
            run.analysisFileExists,
            run.analysisFileExists ? run.vaultUrl : null,
            "No analysis file",
          );
          return `
        <div class="report-info-run">
          <div class="report-info-run-head">
            <span class="report-info-run-name">${escHtml(run.runName)}</span>
            <span class="report-info-run-date">${escHtml(formatDate(run.createdAt))}</span>
          </div>
          ${outputRow}
          ${groupedRow}
          ${analysisRow}
        </div>`;
        })
        .join("");
    }
    renderReportInfoDigests(info.digests || []);
  };

  const renderReportInfoDigests = (digests: ReportInfoDigest[]): void => {
    if (digests.length === 0) {
      reportInfoDigests.innerHTML =
        '<div class="report-info-empty">No digests for this report yet.</div>';
      return;
    }
    reportInfoDigests.innerHTML = digests
      .map((digest) => {
        const safeId = escHtml(digest.id);
        const safePath = escHtml(digest.digestDir);
        const missingBadge = digest.digestDirExists
          ? ""
          : ' <span class="report-info-missing">(missing on disk)</span>';
        const openBtn =
          digest.digestDirExists && digest.digestUrl
            ? `<a class="report-info-path-action" href="${escHtml(digest.digestUrl)}" target="_blank" rel="noopener noreferrer" title="Open digest.json">${openIcon}</a>`
            : "";
        return `
        <div class="report-info-run">
          <div class="report-info-run-head">
            <span class="report-info-run-name">${escHtml(digest.testTitle || "(untitled)")}</span>
            <span class="report-info-run-date">${escHtml(formatDate(digest.createdAt))}</span>
          </div>
          <div class="report-info-path-row">
            <span class="report-info-path-label">Digest dir</span>
            <code class="report-info-path" data-copy="${safePath}">${safePath}${missingBadge}</code>
            <div class="report-info-path-actions">
              <button class="report-info-path-action" type="button" data-action="copy" data-path="${safePath}" title="Copy path">${copyIcon}</button>
              ${openBtn}
              <button class="report-info-path-action danger" type="button" data-action="delete-digest" data-digest-id="${safeId}" data-path="${safePath}" title="Delete">${trashIcon}</button>
            </div>
          </div>
        </div>`;
      })
      .join("");
  };

  const loadReportInfo = async (reportId: string): Promise<void> => {
    try {
      const response = await fetch(
        "/api/report-info?reportId=" + encodeURIComponent(reportId),
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Failed to load report info");
      if (reportInfoCurrentReportId !== reportId) return; // a newer dialog took over
      renderReportInfo(data as ReportInfoResponse);
    } catch (err) {
      console.error("Report info load error:", err);
      if (reportInfoCurrentReportId !== reportId) return;
      reportInfoRuns.innerHTML =
        '<div class="report-info-empty">Failed to load report info.</div>';
      reportInfoDigests.innerHTML =
        '<div class="report-info-empty">Failed to load report info.</div>';
    }
  };

  // Report size is fetched separately so the runs render immediately without waiting on the
  // (potentially multi-GB) recursive disk scan. The result is cached for instant reopens.
  const loadReportSize = async (reportId: string): Promise<void> => {
    if (reportSizeCache.has(reportId)) {
      reportInfoSize.textContent = formatBytes(reportSizeCache.get(reportId)!);
      return;
    }
    reportInfoSize.textContent = "Calculating…";
    try {
      const response = await fetch(
        "/api/report-size?reportId=" + encodeURIComponent(reportId),
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Failed to load report size");
      if (reportInfoCurrentReportId !== reportId) return; // a newer dialog took over
      if (!data.folderExists) {
        reportInfoSize.textContent = "Not on disk";
        return;
      }
      reportSizeCache.set(reportId, data.sizeBytes);
      reportInfoSize.textContent = formatBytes(data.sizeBytes);
    } catch (err) {
      console.error("Report size load error:", err);
      if (reportInfoCurrentReportId === reportId)
        reportInfoSize.textContent = "—";
    }
  };

  const openReportInfoModal = (reportId: string): void => {
    reportInfoCurrentReportId = reportId;
    reportInfoName.textContent = reportId;
    reportInfoSize.textContent = "Calculating…";
    reportInfoRuns.innerHTML = '<div class="report-info-empty">Loading…</div>';
    reportInfoDigests.innerHTML =
      '<div class="report-info-empty">Loading…</div>';
    reportInfoModal.classList.remove("hidden");
    void loadReportInfo(reportId);
    void loadReportSize(reportId);
  };

  const closeReportInfoModal = () => reportInfoModal.classList.add("hidden");
  closeReportInfoModalBtn.addEventListener("click", closeReportInfoModal);
  closeReportInfoModalFooterBtn.addEventListener("click", closeReportInfoModal);

  // Generic promise-based delete confirmation.
  let confirmResolve: ((value: boolean) => void) | null = null;
  const openConfirm = (opts: {
    title: string;
    message: string;
    path?: string;
  }): Promise<boolean> => {
    confirmDeleteTitle.textContent = opts.title;
    confirmDeleteMessage.textContent = opts.message;
    confirmDeletePath.textContent = opts.path || "";
    confirmDeletePath.classList.toggle("hidden", !opts.path);
    confirmDeleteModal.classList.remove("hidden");
    return new Promise<boolean>((resolve) => {
      confirmResolve = resolve;
    });
  };
  const closeConfirm = (result: boolean) => {
    confirmDeleteModal.classList.add("hidden");
    if (confirmResolve) {
      confirmResolve(result);
      confirmResolve = null;
    }
  };
  confirmDeleteConfirmBtn.addEventListener("click", () => closeConfirm(true));
  confirmDeleteCancelBtn.addEventListener("click", () => closeConfirm(false));
  closeConfirmDeleteModalBtn.addEventListener("click", () =>
    closeConfirm(false),
  );

  const refreshAfterRunChange = async (): Promise<void> => {
    try {
      await fetchReports({ showLoading: false });
    } catch {
      /* table refresh is best-effort */
    }
    await loadReportInfo(reportInfoCurrentReportId);
  };

  const deleteRunArtifact = async (
    kind: "output" | "analysis",
    runName: string,
  ): Promise<void> => {
    const isOutput = kind === "output";
    const ok = await openConfirm({
      title: isOutput ? "Delete output directory" : "Delete analysis file",
      message: isOutput
        ? "This permanently deletes the output directory from disk. The analysis file stays mapped to this report."
        : "This permanently deletes the analysis file from disk.",
      path: "",
    });
    if (!ok) return;
    const endpoint = isOutput
      ? "/api/analysis-run/output-dir"
      : "/api/analysis-run/analysis-file";
    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: reportInfoCurrentReportId, runName }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Delete failed");
      await refreshAfterRunChange();
    } catch (err) {
      console.error("Delete artifact error:", err);
      await refreshAfterRunChange();
    }
  };

  reportInfoRuns.addEventListener("click", async (event) => {
    const trigger = (event.target as HTMLElement).closest(
      "[data-action]",
    ) as HTMLElement | null;
    if (!trigger) return;
    event.stopPropagation();
    const action = trigger.dataset.action || "";
    const runName = trigger.dataset.run || "";
    const pathValue = trigger.dataset.path || "";
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(pathValue);
        const original = trigger.innerHTML;
        trigger.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        setTimeout(() => {
          trigger.innerHTML = original;
        }, 1200);
      } catch (err) {
        console.error("Copy path failed:", err);
      }
    } else if (action === "delete-output") {
      await deleteRunArtifact("output", runName);
    } else if (action === "delete-analysis") {
      await deleteRunArtifact("analysis", runName);
    }
  });

  // Right-click any path to reuse the shared "Copy path" context menu.
  reportInfoRuns.addEventListener("contextmenu", (event) => {
    const pathEl = (event.target as HTMLElement).closest(
      ".report-info-path[data-copy]",
    ) as HTMLElement | null;
    if (!pathEl) return;
    event.preventDefault();
    event.stopPropagation();
    const mouseEvent = event as MouseEvent;
    showAnalysisContextMenu(
      mouseEvent.clientX,
      mouseEvent.clientY,
      pathEl.dataset.copy || "",
    );
  });

  const deleteDigest = async (digestId: string): Promise<void> => {
    const ok = await openConfirm({
      title: "Delete digest",
      message: "This permanently deletes the digest directory from disk.",
      path: "",
    });
    if (!ok) return;
    try {
      const response = await fetch("/api/digest", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: reportInfoCurrentReportId, digestId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Delete failed");
      await refreshAfterRunChange();
    } catch (err) {
      console.error("Delete digest error:", err);
      await refreshAfterRunChange();
    }
  };

  reportInfoDigests.addEventListener("click", async (event) => {
    const trigger = (event.target as HTMLElement).closest(
      "[data-action]",
    ) as HTMLElement | null;
    if (!trigger) return;
    event.stopPropagation();
    const action = trigger.dataset.action || "";
    const pathValue = trigger.dataset.path || "";
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(pathValue);
        const original = trigger.innerHTML;
        trigger.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        setTimeout(() => {
          trigger.innerHTML = original;
        }, 1200);
      } catch (err) {
        console.error("Copy path failed:", err);
      }
    } else if (action === "delete-digest") {
      await deleteDigest(trigger.dataset.digestId || "");
    }
  });

  // Right-click any digest path to reuse the shared "Copy path" context menu.
  reportInfoDigests.addEventListener("contextmenu", (event) => {
    const pathEl = (event.target as HTMLElement).closest(
      ".report-info-path[data-copy]",
    ) as HTMLElement | null;
    if (!pathEl) return;
    event.preventDefault();
    event.stopPropagation();
    const mouseEvent = event as MouseEvent;
    showAnalysisContextMenu(
      mouseEvent.clientX,
      mouseEvent.clientY,
      pathEl.dataset.copy || "",
    );
  });

  const filterDigestTests = () => {
    const query = (digestSearchInput?.value || "").toLowerCase().trim();
    activeDigestRows.forEach((row) => {
      const matches = row.title.includes(query);
      row.element.classList.toggle("hidden", !matches);
    });
  };

  if (digestSearchInput) {
    digestSearchInput.addEventListener("input", filterDigestTests);
    digestSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        filterDigestTests();
      }
    });
  }

  if (digestSearchBtn) {
    digestSearchBtn.addEventListener("click", filterDigestTests);
  }

  // Logic to handle selective test trace digestion
  const handleDigest = async (reportPath: string, row: HTMLElement) => {
    showRowProgress(row, "Listing tests...");
    try {
      const response = await fetch("/api/report-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportPath }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      const tests = data.tests || [];
      if (tests.length === 0) {
        hideRowProgress(row, "success", "No traces found");
        return;
      }

      // Hide overlay immediately — we're opening a modal
      const overlay = row.querySelector(".row-progress-overlay") as HTMLElement;
      if (overlay) {
        overlay.classList.add("hidden");
        overlay.classList.remove("progress-active");
      }

      // Reset search state
      if (digestSearchInput) {
        digestSearchInput.value = "";
      }
      activeDigestRows = [];

      // Render tests in modal
      digestTbody.innerHTML = "";
      tests.forEach((test: any) => {
        const tr = document.createElement("tr");
        tr.className = "report-row";

        const outcomeClass = (test.outcome || "skipped").toLowerCase();

        const hasTrace = !!test.tracePath;
        const actionButtonHtml = hasTrace
          ? `<button class="btn primary-btn btn-digest-test">Digest</button>`
          : `<span class="form-hint" style="margin: 0;">No trace</span>`;

        tr.innerHTML = `
                  <td style="width: 15%;">
                      <span style="font-family: monospace; font-size: 0.8rem; color: var(--text-secondary);">${test.projectName || "default"}</span>
                  </td>
                  <td style="width: 50%;">
                      <div style="font-weight: 500;">${test.testTitle}</div>
                      <div style="font-size: 0.8rem; color: var(--text-muted); font-family: monospace; margin-top: 4px;">${test.file}</div>
                      <div class="digest-result-container"></div>
                  </td>
                  <td style="width: 15%;">
                      <span class="outcome-badge ${outcomeClass}">${test.outcome || "unknown"}</span>
                  </td>
                  <td style="width: 20%; text-align: right;" class="col-action-cell">
                      ${actionButtonHtml}
                  </td>
              `;

        if (hasTrace) {
          const digestBtn = tr.querySelector(
            ".btn-digest-test",
          ) as HTMLButtonElement;
          const resultContainer = tr.querySelector(
            ".digest-result-container",
          ) as HTMLElement;

          digestBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await handleDigestTest(
              digestBtn,
              resultContainer,
              reportPath,
              test.tracePath,
            );
          });
        }

        digestTbody.appendChild(tr);
        activeDigestRows.push({
          element: tr,
          title: test.testTitle.toLowerCase(),
        });
      });

      digestModal.classList.remove("hidden");
    } catch (err: any) {
      console.error("Failed to list tests for digest:", err);
      hideRowProgress(row, "error", "Check failed");
      showErrorDialog("Listing report tests failed", err);
    }
  };

  const handleDigestTest = async (
    btn: HTMLButtonElement,
    container: HTMLElement,
    reportPath: string,
    tracePath: string,
  ) => {
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner" style="width: 14px; height: 14px; margin-right: 6px; border-width: 2px; border-top-color: #fff;"></div> Digesting...`;
    container.innerHTML = "";

    try {
      const res = await fetch("/api/digest-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportPath, tracePath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg> Digested`;
      btn.style.backgroundColor = "#238636";
      btn.style.borderColor = "#238636";

      container.innerHTML = `
              <div class="digest-success-info">
                  <div class="digest-status-title">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                      Trace parsed successfully!
                  </div>
                  <div class="digest-path-label">Workspace Folder Location:</div>
                  <div class="digest-path-value">${data.digestFolder}</div>
                  <div class="digest-actions-row">
                      <button class="btn-copy-path" data-path="${data.digestFolder}">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
                          Copy Relative Path
                      </button>
                      <a href="${data.digestUrl}/digest.json" target="_blank" rel="noopener noreferrer" class="digest-link-btn">
                          View digest.json
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-external-link"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                      </a>
                  </div>
              </div>
          `;

      const copyBtn = container.querySelector(
        ".btn-copy-path",
      ) as HTMLButtonElement;
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(data.digestFolder);
          const originalCopyHtml = copyBtn.innerHTML;
          copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg> Copied!`;
          setTimeout(() => {
            copyBtn.innerHTML = originalCopyHtml;
          }, 2000);
        } catch (err) {
          console.error("Failed to copy text: ", err);
        }
      });
    } catch (err: any) {
      console.error("Failed to digest trace:", err);
      btn.innerHTML = `Failed`;
      btn.style.backgroundColor = "#f85149";
      btn.style.borderColor = "#f85149";
      container.innerHTML = `<div class="path-error static-error" style="margin-top: 8px;">Digestion failed: ${err.message || err}</div>`;
    } finally {
      setTimeout(() => {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
        btn.style.backgroundColor = "";
        btn.style.borderColor = "";
      }, 4000);
    }
  };

  const renderAllDiffs = () => {
    const blocks = document.querySelectorAll(
      ".aria-snapshot-block",
    ) as NodeListOf<HTMLElement>;
    const isChecked = ariaDeepEqualCheckbox.checked;

    blocks.forEach((block, index) => {
      const rawExpected = block.dataset.rawExpectedSnapshot || "";
      const rawNew = block.dataset.rawNewSnapshot || "";
      const diffContainer = document.getElementById(`aria-diff-${index}`);
      if (!diffContainer) return;

      const diffLines = computeDiff(
        normalizeIndent(rawExpected),
        normalizeIndent(rawNew),
      );
      let html = "";

      if (isChecked) {
        html += `<div class="diff-line diff-unchanged">- /children: deep-equal</div>`;
      }

      diffLines.forEach((line) => {
        const escapedText = line.text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        html += `<div class="diff-line diff-${line.type}">${escapedText || " "}</div>`;
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

  ariaDeepEqualCheckbox.addEventListener("change", renderAllDiffs);

  const renderTable = (reports: Report[], target: SectionKey) => {
    const context = tableContexts[target];
    const { tbody, section, table } = context;
    tbody.innerHTML = "";
    selectedReports[target].clear();
    if (!reports || reports.length === 0) {
      section.classList.add("hidden");
      syncBulkControls(target);
      return 0;
    }

    section.classList.remove("hidden");
    table.classList.remove("hidden");
    reports.forEach((report) =>
      tbody.appendChild(createReportRow(report, target)),
    );
    syncBulkControls(target);
    return reports.length;
  };

  const renderReportsData = (
    data: ReportsResponse,
    mode: "default" | "search",
  ) => {
    loading.classList.add("hidden");

    const currentCount = renderTable(data.current, "current");
    const archiveCount = renderTable(data.archive, "archive");
    const { configStatus } = data;

    if (mode === "search") {
      if (currentCount === 0 && archiveCount === 0) {
        emptyState.classList.remove("hidden");
        setEmptyStateContent(
          "No Matching Reports",
          "No saved reports matched that metadata and date combination. Adjust the search terms or selected dates and try again.",
        );
      }
      return;
    }

    if (
      !configStatus ||
      (!configStatus.hasCurrent && !configStatus.hasArchive)
    ) {
      emptyState.classList.remove("hidden");
      setEmptyStateContent(
        "Configuration Required",
        "Please open Preferences and configure your report directories to view them here.",
      );
    } else if (currentCount === 0 && archiveCount === 0) {
      emptyState.classList.remove("hidden");
      setEmptyStateContent(
        "No Reports Found",
        "No valid Playwright HTML reports could be found in your configured directories.<br><br>Make sure the selected folders actually contain test runs and the innermost folders contain an <code>index.html</code> right at their root.",
        true,
      );
    }
  };

  const fetchAnalysisRuns = async () => {
    try {
      const response = await fetch("/api/analysis-runs");
      if (!response.ok) {
        analysisRunsByReport = new Map();
        return;
      }
      const data = await response.json();
      analysisRunsByReport = new Map(
        Object.entries(data.runs || {}) as [
          string,
          { runName: string; mtime: string; runDir: string }[],
        ][],
      );
    } catch {
      analysisRunsByReport = new Map();
    }
  };

  const fetchReports = async (
    options: { showLoading?: boolean; render?: boolean } = {},
  ) => {
    const { showLoading = true, render = true } = options;
    resetRenderedState(showLoading);

    try {
      await fetchAnalysisRuns();
      const data = await requestReports("/api/reports");
      cachedReportsData = data;
      if (render) {
        renderReportsData(data, "default");
      } else {
        loading.classList.add("hidden");
      }
      return data;
    } catch (error: any) {
      console.error("Failed to fetch reports:", error);
      loading.classList.add("hidden");
      if (render) {
        emptyState.classList.remove("hidden");
        setEmptyStateContent("Error loading reports", error.message);
      }
      throw error;
    }
  };

  const fetchAndRenderSearchResults = async (
    filters: SearchFilters,
    options: { showLoading?: boolean; updateAppliedState?: boolean } = {},
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
      renderReportsData(data, "search");
      return data;
    } catch (error: any) {
      console.error("Failed to search reports:", error);
      loading.classList.add("hidden");
      emptyState.classList.remove("hidden");
      setEmptyStateContent(
        "Search Unavailable",
        error.message || "The report search could not be completed.",
      );
      throw error;
    }
  };

  const searchReportsAndRender = async (
    options: { showLoading?: boolean } = {},
  ) => {
    const { showLoading = true } = options;
    const filters = readSearchInputs();
    setDraftFilters(filters);

    if (!hasSearchFilters(filters)) {
      setAppliedFilters(null);
      restoreDefaultDashboard();
      return cachedReportsData ?? fetchReports({ showLoading, render: true });
    }

    return fetchAndRenderSearchResults(filters, {
      showLoading,
      updateAppliedState: true,
    });
  };

  const restoreDefaultDashboard = () => {
    resetRenderedState(false);
    if (cachedReportsData) {
      renderReportsData(cachedReportsData, "default");
      return;
    }

    void fetchReports();
  };

  const reloadVisibleReports = async () => {
    const appliedFilters = activeSearchState.applied;
    if (appliedFilters && hasSearchFilters(appliedFilters)) {
      await fetchReports({ showLoading: true, render: false });
      await fetchAndRenderSearchResults(appliedFilters, {
        showLoading: false,
        updateAppliedState: false,
      });
      return;
    }

    await fetchReports();
  };

  const openSearchPanel = () => {
    activeSearchState.isOpen = true;
    setDraftFilters(activeSearchState.applied || createEmptySearchFilters());
    searchPanel.classList.remove("hidden");
    updateSearchButtonState();
    window.setTimeout(() => searchInput.focus(), 0);
  };

  const closeSearchPanel = () => {
    activeSearchState.isOpen = false;
    setDraftFilters(activeSearchState.applied || createEmptySearchFilters());
    searchPanel.classList.add("hidden");
    updateSearchButtonState();
  };

  const resetSearchFilters = () => {
    setAppliedFilters(null);
    restoreDefaultDashboard();
    window.setTimeout(() => searchInput.focus(), 0);
  };

  // --- Modal Logic ---

  const openModal = async () => {
    modalError.classList.add("hidden");
    settingsModal.classList.remove("hidden");

    try {
      const response = await fetch("/api/config");
      const data = await response.json();
      currentPathInput.value = data.currentPath || "";
      archivePathInput.value = data.archivePath || "";
      projectPathInput.value = data.projectPath || "";
      vaultPathInput.value = data.vaultPath || "";
      browserstackUsernameInput.value = data.browserstackUsername || "";
      browserstackKeyInput.value = data.browserstackAccessKey || "";
      browserstackConfigInput.value = data.browserstackConfig || "";
      copilotTokenInput.value = data.copilotToken || "";
      setCopilotModelFieldValue("small", data.copilotModel || "");
      setCopilotModelFieldValue("big", data.copilotBigModel || "");
    } catch (err) {
      console.error("Failed to load config:", err);
    }
  };

  const closeModal = () => {
    settingsModal.classList.add("hidden");
  };

  settingsBtn.addEventListener("click", openModal);
  closeModalBtn.addEventListener("click", closeModal);
  cancelModalBtn.addEventListener("click", closeModal);

  // --- Delete Modal Logic ---
  const closeDeleteModal = () => {
    deleteRequest = null;
    deleteModal.classList.add("hidden");
    deleteModalError.classList.add("hidden");
  };

  closeDeleteModalBtn.addEventListener("click", closeDeleteModal);
  cancelDeleteBtn.addEventListener("click", closeDeleteModal);

  confirmDeleteBtn.addEventListener("click", async () => {
    if (!deleteRequest) return;

    const currentRequest = deleteRequest;

    deleteModalError.classList.add("hidden");
    confirmDeleteBtn.disabled = true;
    confirmDeleteBtn.innerHTML = `<div class="spinner" style="width: 14px; height: 14px; margin-right: 6px; border-width: 2px; border-top-color: #fff;"></div> Deleting...`;

    try {
      const result = await performDeleteRequests(currentRequest.reportPaths);

      if (result.failures.length === currentRequest.reportPaths.length) {
        throw new Error(result.failures[0] || "Failed to delete reports");
      }

      closeDeleteModal();
      await reloadVisibleReports();

      if (result.failures.length > 0) {
        alert(
          `Deleted ${result.successCount} reports. Failed to delete ${result.failures.length}. First error: ${result.failures[0]}`,
        );
      }
    } catch (err: any) {
      deleteModalError.textContent = err.message;
      deleteModalError.classList.remove("hidden");
    } finally {
      confirmDeleteBtn.disabled = false;
      confirmDeleteBtn.textContent = currentRequest.confirmLabel;
    }
  });

  // Intentionally not closing on backdrop click as requested
  // User must use standard close/cancel/save buttons

  saveModalBtn.addEventListener("click", async () => {
    const currentPath = currentPathInput.value.trim();
    const archivePath = archivePathInput.value.trim();
    const projectPath = projectPathInput.value.trim();
    const vaultPath = vaultPathInput.value.trim();
    const browserstackUsername = browserstackUsernameInput.value.trim();
    const browserstackAccessKey = browserstackKeyInput.value.trim();
    const browserstackConfig = browserstackConfigInput.value.trim();
    const copilotToken = copilotTokenInput.value.trim();

    modalError.classList.add("hidden");
    saveModalBtn.disabled = true;
    saveModalBtn.textContent = "Saving...";

    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPath,
          archivePath,
          projectPath,
          vaultPath,
          browserstackUsername,
          browserstackAccessKey,
          browserstackConfig,
          copilotToken,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to update paths");
      }

      closeModal();
      updateRunTestsBtnForProjectPath(projectPath);
      await reloadVisibleReports();
      document.getElementById("copilot-status-chip")?.click();
    } catch (err: any) {
      modalError.textContent = err.message;
      modalError.classList.remove("hidden");
    } finally {
      saveModalBtn.disabled = false;
      saveModalBtn.textContent = "Save Changes";
    }
  });

  // --- Toolbars & Globals ---

  (Object.keys(tableContexts) as SectionKey[]).forEach((target) => {
    const context = tableContexts[target];

    context.selectAllBtn.addEventListener("click", () => {
      selectAllRows(target);
    });

    context.selectNoneBtn.addEventListener("click", () => {
      clearSelection(target);
    });

    context.bulkMenuTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = !context.bulkMenuPanel.classList.contains("hidden");
      closeBulkMenus();
      if (!isOpen && selectedReports[target].size > 0) {
        context.bulkMenuPanel.classList.remove("hidden");
        context.bulkMenuTrigger.setAttribute("aria-expanded", "true");
      }
    });

    const bulkActions =
      context.bulkMenuPanel.querySelectorAll<HTMLButtonElement>(
        ".bulk-menu-action",
      );
    bulkActions.forEach((actionBtn) => {
      actionBtn.addEventListener("click", async (event) => {
        event.stopPropagation();

        const action = actionBtn.dataset.action;
        const selectedPaths = Array.from(selectedReports[target]);
        if (selectedPaths.length === 0 || !action) return;

        closeBulkMenus();

        if (action === "delete") {
          openDeleteModal({
            reportPaths: selectedPaths,
            title:
              selectedPaths.length === 1
                ? "Delete Report"
                : "Delete Selected Reports",
            message:
              selectedPaths.length === 1
                ? `Are you sure that you want to delete the selected ${getTableLabel(target)} report?`
                : `Are you sure that you want to delete ${selectedPaths.length} selected ${getTableLabel(target)} reports?`,
            confirmLabel:
              selectedPaths.length === 1
                ? "Delete"
                : `Delete ${selectedPaths.length} Reports`,
          });
          return;
        }

        if (action === "archive") {
          if (!(await ensureArchiveCapacity(selectedPaths.length))) {
            return;
          }
          const originalText = actionBtn.textContent || "Archive selected";
          activeBulkTarget = target;
          setSelectionControlsDisabled(target, true);
          actionBtn.textContent = "Archiving...";

          try {
            const result = await performArchiveRequests(selectedPaths);
            if (result.failures.length === selectedPaths.length) {
              throw new Error(
                result.failures[0] || "Failed to archive reports",
              );
            }

            await reloadVisibleReports();

            if (result.failures.length > 0) {
              alert(
                `Archived ${result.successCount} reports. Failed to archive ${result.failures.length}. First error: ${result.failures[0]}`,
              );
            }
          } catch (error: any) {
            alert(error.message || "Failed to archive reports");
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

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest(".bulk-menu")) {
      closeBulkMenus();
    }
    if (!target.closest(".row-overflow-menu")) {
      closeAllOverflowMenus();
    }
    if (!target.closest(".analysis-menu")) {
      closeAllAnalysisMenus();
    }
    if (!target.closest(".analysis-context-menu")) {
      hideAnalysisContextMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeBulkMenus();
      closeAllOverflowMenus();
      closeAllAnalysisMenus();
      hideAnalysisContextMenu();
    }
  });

  searchToggleBtn.addEventListener("click", () => {
    if (activeSearchState.isOpen) {
      searchInput.focus();
      return;
    }
    openSearchPanel();
  });

  searchCloseBtn.addEventListener("click", closeSearchPanel);
  searchSubmitBtn.addEventListener("click", () => {
    void searchReportsAndRender();
  });
  searchResetBtn.addEventListener("click", resetSearchFilters);

  [searchInput, searchRangeStartInput, searchRangeEndInput].forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void searchReportsAndRender();
      }
    });
  });

  refreshBtn.addEventListener("click", () => {
    const icon = refreshBtn.querySelector("svg") as SVGSVGElement;
    if (icon) {
      icon.style.transition = "transform 0.5s ease";
      icon.style.transform = `rotate(360deg)`;
    }

    reloadVisibleReports().then(() => {
      setTimeout(() => {
        if (icon) {
          icon.style.transition = "none";
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
