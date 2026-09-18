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
  return {
    singleAnalysisPreserved: true,
    cancellationPreservedFiles: true,
    confirmedRerun: true,
    duplicateCleanup: true,
    mobileDialogFits: true,
  };
};
