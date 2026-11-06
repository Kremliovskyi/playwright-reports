namespace ReportInfoPanel {
  // ----- Report Info dialog -----
  export interface ReportInfoRun {
    runName: string;
    createdAt: string;
    importedAt?: string;
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
    canImport: boolean;
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
    const {
      fetchReports,
      formatDate,
      showErrorDialog,
      showAnalysisContextMenu,
      openConfirm,
    } = deps;
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
    const importControls = document.createElement("section");
    importControls.className = "form-group";
    importControls.innerHTML = `
      <button type="button" class="btn" automation-id="analysis-import-open">Import output directory</button>
      <button type="button" class="btn hidden" automation-id="analysis-import-recover">Recover interrupted import</button>
      <div class="hidden" data-import-form>
        <label for="analysis-import-path">Directory on the dashboard machine</label>
        <input id="analysis-import-path" automation-id="analysis-import-path" class="path-input full-width"
          placeholder="Absolute run directory or GitHub extraction wrapper" />
        <button type="button" class="btn" automation-id="analysis-import-inspect">Inspect</button>
        <pre data-import-preview automation-id="analysis-import-preview" style="white-space: pre-wrap; overflow-wrap: anywhere"></pre>
        <label class="hidden" data-import-confirm>
          <input type="checkbox" automation-id="analysis-import-unverified" />
          I confirm that this analysis belongs to the selected report despite insufficient matching metadata.
        </label>
        <button type="button" class="btn hidden" automation-id="analysis-import-commit">Import</button>
      </div>
      <p data-import-status automation-id="analysis-import-status" class="form-hint" role="status"></p>`;
    reportInfoRuns.before(importControls);
    const importOpen = importControls.querySelector<HTMLButtonElement>(
      '[automation-id="analysis-import-open"]',
    )!;
    const importRecover = importControls.querySelector<HTMLButtonElement>(
      '[automation-id="analysis-import-recover"]',
    )!;
    const importForm =
      importControls.querySelector<HTMLElement>("[data-import-form]")!;
    const importPath = importControls.querySelector<HTMLInputElement>(
      "#analysis-import-path",
    )!;
    const importInspect = importControls.querySelector<HTMLButtonElement>(
      '[automation-id="analysis-import-inspect"]',
    )!;
    const importCommit = importControls.querySelector<HTMLButtonElement>(
      '[automation-id="analysis-import-commit"]',
    )!;
    const importConfirm = importControls.querySelector<HTMLElement>(
      "[data-import-confirm]",
    )!;
    const importUnverified = importControls.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    const importPreview = importControls.querySelector<HTMLElement>(
      "[data-import-preview]",
    )!;
    const importStatus = importControls.querySelector<HTMLElement>(
      "[data-import-status]",
    )!;
    let preview: {
      source: string;
      version: string;
      reportUuid: string;
      runName: string;
      grouped: boolean;
      finalName: string;
      verified: boolean;
      fileCount: number;
      bytes: number;
      destination: string;
      warnings: string[];
      inventory: AnalysisInventory;
      createdAt: string;
    } | null = null;
    let importing = false;
    let recoveries: { transaction: string; committed: boolean }[] = [];
    importRecover.addEventListener("click", async () => {
      const reportId = reportInfoCurrentReportId;
      const reportUuid = reportInfoCurrentUuid;
      const transaction = recoveries[0];
      if (
        !transaction ||
        !(await openConfirm({
          title: "Recover interrupted import",
          message: transaction.committed
            ? "Keep the committed import and finish cleaning its old backups?"
            : "Restore the previous analysis and discard the interrupted copy?",
          path: transaction.transaction,
        }))
      )
        return;
      if (
        reportId !== reportInfoCurrentReportId ||
        reportUuid !== reportInfoCurrentUuid
      )
        return;
      importRecover.disabled = true;
      try {
        const response = await fetch("/api/analysis/import/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reportId,
            reportUuid,
            transaction: transaction.transaction,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Recovery failed");
        importStatus.textContent = "Recovery complete.";
        await refreshAfterRunChange();
      } catch (error) {
        importStatus.textContent =
          error instanceof Error ? error.message : String(error);
      } finally {
        importRecover.disabled = false;
      }
    });
    importOpen.addEventListener("click", () =>
      importForm.classList.toggle("hidden"),
    );
    importPath.addEventListener("input", () => {
      preview = null;
      importCommit.classList.add("hidden");
    });
    importInspect.addEventListener("click", async () => {
      const reportId = reportInfoCurrentReportId;
      const reportUuid = reportInfoCurrentUuid;
      const sourcePath = importPath.value;
      preview = null;
      importCommit.classList.add("hidden");
      importInspect.disabled = true;
      importStatus.textContent =
        "Inspecting the directory and report association...";
      try {
        const response = await fetch("/api/analysis/import/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportId, reportUuid, sourcePath }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Inspection failed");
        if (
          reportId !== reportInfoCurrentReportId ||
          reportUuid !== reportInfoCurrentUuid ||
          sourcePath !== importPath.value
        )
          return;
        preview = data;
        importPreview.textContent = [
          `Run: ${data.runName}`,
          `Source: ${data.source}`,
          `Destination: ${data.destination}`,
          `Created: ${data.createdAt || "Unknown"}`,
          `${data.fileCount} files / ${formatBytes(data.bytes)}`,
          `Grouped: ${data.grouped ? "found" : "not present"}`,
          `Final: ${data.finalName || "not present"}`,
          `Association: ${data.verified ? "verified by trace/retry identities" : "UNVERIFIED"}`,
          `Provenance: ${JSON.stringify(data.sourceMetadata)}`,
          ...data.warnings,
        ].join("\n");
        importUnverified.checked = false;
        importConfirm.classList.toggle("hidden", data.verified);
        importCommit.textContent = data.inventory.entries.length
          ? "Replace analysis"
          : "Import";
        importCommit.disabled = data.inventory.needsReview;
        importCommit.classList.remove("hidden");
        importStatus.textContent = data.inventory.needsReview
          ? "Resolve the current analysis review before importing."
          : "Inspection complete. No files have been changed.";
      } catch (error) {
        if (reportId === reportInfoCurrentReportId)
          importStatus.textContent =
            error instanceof Error ? error.message : String(error);
      } finally {
        importInspect.disabled = false;
      }
    });
    importCommit.addEventListener("click", async () => {
      if (!preview || importing) return;
      if (!preview.verified && !importUnverified.checked) {
        importStatus.textContent =
          "Confirm the unverified association before importing.";
        return;
      }
      const selected = preview;
      const reportId = reportInfoCurrentReportId;
      if (
        selected.inventory.entries.length &&
        !(await openConfirm({
          title: "Replace analysis",
          message:
            "This replaces the current analysis, including its final. The imported source directory remains unchanged.",
          path: selected.inventory.entries
            .flatMap((entry) => [
              ...(entry.output ? [entry.output.path] : []),
              ...entry.notes.map((note) => note.path),
            ])
            .join("\n"),
        }))
      )
        return;
      if (
        reportId !== reportInfoCurrentReportId ||
        selected.reportUuid !== reportInfoCurrentUuid
      )
        return;
      importing = true;
      importPath.disabled = true;
      importInspect.disabled = importCommit.disabled = true;
      importStatus.textContent =
        "Copying and validating analysis. No AI calls are made.";
      const progress = new EventSource("/api/logs");
      progress.addEventListener("analysis-import", (event: MessageEvent) => {
        const data = JSON.parse(event.data);
        if (
          data.reportUuid === selected.reportUuid &&
          reportInfoCurrentReportId === reportId
        )
          importStatus.textContent = `Copying files: ${data.completed}/${data.total}`;
      });
      try {
        const response = await fetch("/api/analysis/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reportId,
            reportUuid: selected.reportUuid,
            sourcePath: selected.source,
            sourceVersion: selected.version,
            analysisVersion: selected.inventory.version,
            replaceRunId: selected.inventory.entries[0]?.id,
            confirmUnverified: importUnverified.checked,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Import failed");
        if (reportId !== reportInfoCurrentReportId) return;
        importStatus.textContent = data.unchanged
          ? "This bundle is already imported."
          : "Import complete. Original source preserved.";
        importForm.classList.add("hidden");
        preview = null;
        await refreshAfterRunChange();
      } catch (error) {
        if (reportId === reportInfoCurrentReportId) {
          importStatus.textContent =
            error instanceof Error ? error.message : String(error);
          await loadReportInfo(reportId);
        }
      } finally {
        progress.close();
        importing = false;
        importPath.disabled = false;
        importInspect.disabled = importCommit.disabled = false;
        importOpen.disabled = importOpen.title !== "" || recoveries.length > 0;
      }
    });
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
          : `<button class="report-info-path-action danger" automation-id="analysis-delete-${kind}" type="button" data-action="delete-${kind}" data-run="${safeRun}" data-path="${safePath}" title="Delete">${trashIcon}</button>`;
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
      importOpen.disabled =
        !info.canImport || importing || recoveries.length > 0;
      importOpen.title = info.canImport
        ? ""
        : "Import is available only for current reports.";
      if (!info.canImport) importForm.classList.add("hidden");
      const review = document.getElementById("report-info-review")!;
      review.replaceChildren();
      review.classList.toggle("hidden", !info.analysisInventory?.needsReview);
      if (info.analysisInventory?.needsReview) {
        const message = document.createElement("p");
        message.textContent =
          (info.analysisInventory.duplicated
            ? "Duplicate analysis data found. No files have been deleted."
            : "Existing analysis records need review. All files have been preserved.") +
          "\n" +
          info.analysisInventory.issues.join("\n");
        const button = document.createElement("button");
        button.className = "btn";
        button.textContent = "Review analysis data";
        button.addEventListener(
          "click",
          () =>
            void reviewAnalysisDuplicates(
              info.reportId,
              info.analysisInventory,
            ),
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
            <span class="report-info-run-date">${escHtml(run.createdAt ? formatDate(run.createdAt) : "Analysis date unknown")}${run.importedAt ? ` (imported ${escHtml(formatDate(run.importedAt))})` : ""}</span>
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
        const reconciliation = await fetch("/api/analysis/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reportId,
            ...(reportInfoCurrentUuid
              ? { reportUuid: reportInfoCurrentUuid }
              : {}),
          }),
        });
        if (!reconciliation.ok) {
          const result = await reconciliation.json();
          importStatus.textContent =
            result.error ||
            result.issues?.join("\n") ||
            "Analysis requires review.";
        }
        const response = await fetch(
          "/api/report-info?reportId=" + encodeURIComponent(reportId),
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Failed to load report info");
        if (reportInfoCurrentReportId !== reportId) return; // a newer dialog took over
        reportInfoCurrentUuid = data.reportUuid;
        const recoveryResponse = await fetch(
          "/api/analysis/import/recovery?reportId=" +
            encodeURIComponent(reportId),
        );
        const recoveryData = await recoveryResponse.json();
        if (!recoveryResponse.ok)
          throw new Error(
            recoveryData.error || "Recovery status could not be loaded",
          );
        if (reportInfoCurrentReportId !== reportId) return;
        recoveries = recoveryData.transactions;
        importRecover.classList.toggle("hidden", recoveries.length === 0);
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
        reportInfoSize.textContent = formatBytes(
          reportSizeCache.get(reportId)!,
        );
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
      preview = null;
      recoveries = [];
      importRecover.classList.add("hidden");
      importOpen.disabled = true;
      importForm.classList.add("hidden");
      importCommit.classList.add("hidden");
      importStatus.textContent = "";
      reportInfoName.textContent = reportId;
      reportInfoSize.textContent = "Calculating…";
      reportInfoRuns.innerHTML =
        '<div class="report-info-empty">Loading…</div>';
      reportInfoDigests.innerHTML =
        '<div class="report-info-empty">Loading…</div>';
      reportInfoModal.classList.remove("hidden");
      void loadReportInfo(reportId);
      void loadReportSize(reportId);
    };

    const closeReportInfoModal = () => reportInfoModal.classList.add("hidden");
    closeReportInfoModalBtn.addEventListener("click", closeReportInfoModal);
    closeReportInfoModalFooterBtn.addEventListener(
      "click",
      closeReportInfoModal,
    );

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
          ? "The final is copied to managed retained storage before deleting output. Raw evidence and grouped output are deleted. If no final exists, no analysis is retained."
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
      reportSizeCache,
      loadReportInfo,
      openReportInfoModal,
      reviewAnalysisDuplicates,
      get currentReportId() {
        return reportInfoCurrentReportId;
      },
    };
  }
}
