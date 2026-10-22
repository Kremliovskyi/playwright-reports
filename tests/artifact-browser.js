async (page) => {
  const verify = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const origin = await page.evaluate(() => location.origin);
  const info = async (reportId) =>
    (
      await page.request.get(`${origin}/api/report-info?reportId=${reportId}`)
    ).json();
  const row = (reportId) =>
    page.locator(
      `.report-row[data-path="/reports/current/${reportId}/index.html"]`,
    );
  const dialog = page.getByRole("alertdialog");
  const openRerun = async () => {
    await row("fixture-report")
      .getByRole("button", { name: "More actions" })
      .click();
    await row("fixture-report")
      .getByRole("button", { name: "Analyze Failures" })
      .click();
    await dialog.waitFor();
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  const original = await info("fixture-report");
  await row("fixture-report")
    .getByRole("button", { name: "Report Info" })
    .click();
  await page.locator("#report-info-runs .report-info-run").waitFor();
  verify(
    (await page.locator("#report-info-runs .report-info-run").count()) === 1,
    "Single report must have one Analysis card",
  );
  verify(
    !(await page.locator("#report-info-review").isVisible()),
    "Healthy reports must not show a duplicate warning",
  );
  await page.locator("#close-report-info-modal-footer-btn").click();
  const originalDate = await row("fixture-report").locator(".col-date").innerText();
  let releaseRename;
  const renameGate = new Promise((resolve) => { releaseRename = resolve; });
  await page.route("**/api/report-rename", async (route) => {
    await renameGate;
    await route.continue();
  });
  await row("fixture-report").locator(".origin-input").fill("renamed fixture");
  const renameResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/report-rename"),
  );
  await row("fixture-report").getByRole("button", { name: "Report Info" }).click();
  verify(!(await page.locator("#report-info-modal").isVisible()), "Info must wait for the pending rename");
  releaseRename();
  verify((await renameResponse).ok(), "Inline rename failed");
  await page.locator("#report-info-runs .report-info-run").waitFor();
  verify((await info("renamed fixture")).runs[0].runName === original.runs[0].runName, "Rename detached analysis");
  verify(
    (await row("renamed fixture").getByRole("button", { name: "Report Info" }).getAttribute("data-report-id")) === "renamed fixture",
    "Info identity must follow rename",
  );
  await page.unroute("**/api/report-rename");
  await page.reload();
  await row("renamed fixture").waitFor();
  verify((await row("renamed fixture").locator(".col-date").innerText()) === originalDate, "Rename changed the displayed date");
  await row("renamed fixture").getByRole("button", { name: "Report Info" }).click();
  await page.locator("#report-info-runs .report-info-run").waitFor();
  verify((await page.locator("#report-info-runs").innerText()).includes(original.runs[0].runName), "Reload lost analysis links");
  await page.locator("#close-report-info-modal-footer-btn").click();
  const restoreName = page.waitForResponse((response) => response.url().endsWith("/api/report-rename"));
  await row("renamed fixture").locator(".origin-input").fill("fixture-report");
  await row("renamed fixture").locator(".origin-input").press("Enter");
  verify((await restoreName).ok(), "Restoring fixture name failed");
  await row("fixture-report").waitFor();
  await openRerun();
  verify(
    await dialog
      .getByRole("button", { name: "Cancel", exact: true })
      .evaluate((element) => element === document.activeElement),
    "Cancel must receive initial focus",
  );
  verify(
    (await dialog.innerText()).includes("cannot be restored"),
    "Rerun warning must describe permanent loss",
  );
  await page.screenshot({ path: "tests/.browser-results/rerun-desktop.png" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  verify(
    JSON.stringify((await info("fixture-report")).runs) ===
      JSON.stringify(original.runs),
    "Escape changed existing analysis",
  );
  await openRerun();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  verify(
    JSON.stringify((await info("fixture-report")).runs) ===
      JSON.stringify(original.runs),
    "Cancel changed existing analysis",
  );
  await openRerun();
  await dialog
    .getByRole("button", { name: "Delete & Analyze", exact: true })
    .click();
  await page.locator("#failures-modal").waitFor();
  const replacement = await info("fixture-report");
  verify(
    replacement.runs.length === 1 &&
      replacement.runs[0].runName !== original.runs[0].runName,
    "Replacement must retain exactly one new analysis",
  );
  await page.locator("#failures-modal .modal-header button").click();
  const duplicateBefore = await info("duplicate-report");
  await row("duplicate-report")
    .getByRole("button", { name: "Report Info" })
    .click();
  await page.getByRole("button", { name: "Review analysis data" }).click();
  await dialog.waitFor();
  verify(
    await dialog
      .getByRole("button", { name: "Delete Selected Duplicates" })
      .isDisabled(),
    "Deletion must require a keeper selection",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByLabel("Analysis to keep").selectOption("0");
  const paths = await page.locator("#confirm-delete-path").innerText();
  verify(
    paths.includes("KEEP") && paths.includes("DELETE"),
    "Duplicate review must list retained and removed paths",
  );
  const bounds = await dialog.locator(".modal-content").boundingBox();
  verify(
    bounds.x >= 0 &&
      bounds.x + bounds.width <= 391 &&
      bounds.y >= 0 &&
      bounds.y + bounds.height <= 845,
    "Confirmation dialog must fit the mobile viewport",
  );
  await page.screenshot({
    path: "tests/.browser-results/duplicates-mobile.png",
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  verify(
    JSON.stringify((await info("duplicate-report")).runs) ===
      JSON.stringify(duplicateBefore.runs),
    "Duplicate Cancel changed files or mappings",
  );
  await page.getByRole("button", { name: "Review analysis data" }).click();
  await dialog.getByLabel("Analysis to keep").selectOption("0");
  const completed = page.waitForResponse((response) =>
    response.url().endsWith("/api/analysis/consolidate"),
  );
  await dialog
    .getByRole("button", { name: "Delete Selected Duplicates" })
    .click();
  verify((await completed).ok(), "Confirmed duplicate cleanup failed");
  const consolidated = await info("duplicate-report");
  verify(
    consolidated.runs.length === 1,
    "Duplicate cleanup must retain one analysis",
  );
  verify(
    consolidated.runs[0].runName ===
      duplicateBefore.analysisInventory.entries[0].runName,
    "Duplicate cleanup removed the selected analysis",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#close-report-info-modal-footer-btn").click();
  await row("fixture-report").getByRole("button", { name: "Archive Report" }).click();
  const archiveResponse = page.waitForResponse((response) => response.url().endsWith("/api/archive"));
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  const archiveResult = await archiveResponse;
  verify(archiveResult.ok(), "Grouped-only archive failed");
  const { newName } = await archiveResult.json();
  const archived = page.locator(`#archive-tbody .report-row[data-path="/reports/archive/${newName}/index.html"]`);
  await archived.getByRole("button", { name: "Report Info" }).click();
  await page.locator("#report-info-runs .report-info-run").waitFor();
  const archivedInfo = await info(newName);
  verify(archivedInfo.runs[0].groupedAnalysisExists && !archivedInfo.runs[0].analysisFileExists, "Grouped fallback must remain distinct from a final note");
  const groupedRow = page.locator("#report-info-runs .report-info-path-row").filter({ hasText: "Grouped analysis" });
  verify((await groupedRow.locator("[data-action=copy]").getAttribute("data-path")) === archivedInfo.runs[0].groupedAnalysisFile, "Copy must target the preserved grouped file");
  const [editor] = await Promise.all([
    page.waitForEvent("popup"),
    groupedRow.getByTitle("Open", { exact: true }).click(),
  ]);
  await editor.getByRole("button", { name: "Edit", exact: true }).click();
  await editor.locator("textarea").fill("# Edited archived grouped analysis");
  const saved = editor.waitForResponse((response) => response.request().method() === "PUT");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  verify((await saved).ok(), "Archived grouped edit failed");
  await editor.close();
  return {
    singleAnalysisPreserved: true,
    cancellationPreservedFiles: true,
    confirmedRerun: true,
    duplicateCleanup: true,
    mobileDialogFits: true,
    renameSurvivesReload: true,
    groupedArchiveEditable: true,
  };
}
