namespace ReportInfoPanel {
  // ----- Report Info dialog -----
  export interface ReportInfoRun {
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
  export interface ReportInfoResponse {
    reportId: string;
    reportUuid: string;
    folder: string;
    folderExists: boolean;
    runs: ReportInfoRun[];
    digests: ReportInfoDigest[];
    analysisInventory: AnalysisInventory;
  }
  export interface AnalysisInventoryEntry {
    id: string;
    runName: string;
    createdAt: string;
    output: { path: string } | null;
    notes: { path: string }[];
    grouped?: { path: string } | null;
  }
  export interface AnalysisInventory {
    version: string;
    needsReview: boolean;
    duplicated: boolean;
    entries: AnalysisInventoryEntry[];
    choices: {
      runId: string;
      keepPaths: string[];
      removePaths: string[];
      blockedReason: string;
    }[];
    issues: string[];
  }
  export interface ReportInfoDigest {
    id: string;
    testTitle: string;
    createdAt: string;
    digestDir: string;
    digestDirExists: boolean;
    digestUrl: string | null;
  }


  export function create(deps: {
    fetchReports: (options: { showLoading: boolean }) => Promise<unknown>;
    formatDate: (date: string) => string;
    showErrorDialog: (title: string, error: unknown) => void;
    showAnalysisContextMenu: (x: number, y: number, path: string) => void;
    openConfirm: ReturnType<typeof DashboardConfirm.create>;
  }) {
    const { fetchReports, formatDate, showErrorDialog, showAnalysisContextMenu, openConfirm } = deps;
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

    let reportInfoCurrentReportId = "";
    let reportInfoCurrentUuid = "";
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
      const review = document.getElementById("report-info-review")!;
      review.replaceChildren();
      review.classList.toggle("hidden", !info.analysisInventory?.needsReview);
      if (info.analysisInventory?.needsReview) {
        const message = document.createElement("p");
        message.textContent = info.analysisInventory.duplicated
          ? "Duplicate analysis data found. No files have been deleted."
          : "Existing analysis records need review. All files have been preserved.";
        const button = document.createElement("button");
        button.className = "btn";
        button.textContent = "Review analysis data";
        button.addEventListener(
          "click",
          () =>
            void reviewAnalysisDuplicates(info.reportId, info.analysisInventory),
        );
        review.append(message, button);
      }
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
        reportInfoCurrentUuid = data.reportUuid;
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
      reportInfoCurrentUuid = "";
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

    const reviewAnalysisDuplicates = async (
      reportId: string,
      inventory: AnalysisInventory,
    ): Promise<void> => {
      const reportUuid = reportInfoCurrentUuid;
      let selected = -1;
      const confirmed = await openConfirm({
        title: inventory.duplicated
          ? "Duplicate analysis data found"
          : "Analysis data needs review",
        message: `Report: ${reportId}. Only the duplicate files listed for removal will be deleted. The selected analysis will be preserved.`,
        path: inventory.entries
          .flatMap((entry) => [
            entry.runName,
            ...(entry.output ? [entry.output.path] : []),
            ...entry.notes.map((note) => note.path),
          ])
          .join("\n"),
        confirmLabel: "Delete Selected Duplicates",
        choices: inventory.choices.map((choice) => ({
          label:
            inventory.entries.find((entry) => entry.id === choice.runId)
              ?.runName || choice.runId,
          path: `KEEP\n${choice.keepPaths.join("\n")}\n\nDELETE\n${choice.removePaths.join("\n") || "No files (duplicate records only)"}`,
          disabled: !!choice.blockedReason,
          reason: choice.blockedReason,
        })),
        onSelect: (index) => {
          selected = index;
        },
      });
      if (!confirmed || selected < 0) return;
      try {
        const response = await fetch("/api/analysis/consolidate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reportId,
            reportUuid,
            keepRunId: inventory.choices[selected].runId,
            version: inventory.version,
          }),
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error || "Failed to remove duplicate analysis data.",
          );
      } catch (error) {
        showErrorDialog("Analysis cleanup failed", error);
      }
      await refreshAfterRunChange();
    };

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
      const reportId = reportInfoCurrentReportId;
      const reportUuid = reportInfoCurrentUuid;
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
          body: JSON.stringify({ reportId, reportUuid, runName }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Delete failed");
        await refreshAfterRunChange();
      } catch (err) {
        console.error("Delete artifact error:", err);
        showErrorDialog("Delete artifact failed", err);
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
      const reportId = reportInfoCurrentReportId;
      const reportUuid = reportInfoCurrentUuid;
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
          body: JSON.stringify({ reportId, reportUuid, digestId }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Delete failed");
        await refreshAfterRunChange();
      } catch (err) {
        console.error("Delete digest error:", err);
        showErrorDialog("Delete digest failed", err);
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


    return {
      reportSizeCache, loadReportInfo, openReportInfoModal, reviewAnalysisDuplicates,
      get currentReportId() { return reportInfoCurrentReportId; }
    };
  }
}
