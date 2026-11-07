// prettier-ignore
async (page) => {
  const verify = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const origin = await page.evaluate(() => location.origin)
  const source = await page.evaluate(() =>
    new URL(location.href).searchParams.get("source"),
  )
  verify(source, "The isolated launcher must supply a source directory.")
  const control = (name) => page.locator(`[automation-id="${name}"]`)
  const info = async () =>
    (
      await page.request.get(
        origin + "/api/report-info?reportId=fixture-report",
      )
    ).json()
  await control("report-info-open").first().click()
  await control("analysis-import-open").waitFor()
  await page.waitForFunction(
    () =>
      !document.querySelector('[automation-id="analysis-import-open"]')
        .disabled,
  )
  await control("analysis-import-open").click()
  const dialog = page.getByRole("dialog", { name: "Import output directory", exact: true })
  await dialog.waitFor()
  verify(
    await control("analysis-import-path").evaluate(el => el === document.activeElement),
    "Opening the dialog must focus the directory input",
  )
  verify(
    await control("report-info-dialog").evaluate(el => el.inert),
    "Report Info must not be interactive behind the import dialog",
  )
  const closeButton = dialog.getByRole("button", { name: "Close import dialog" })
  await closeButton.focus()
  await page.keyboard.press("Shift+Tab")
  verify(
    await control("analysis-import-cancel").evaluate(el => el === document.activeElement),
    "Shift+Tab must stay inside the dialog",
  )
  await page.keyboard.press("Tab")
  verify(
    await closeButton.evaluate(el => el === document.activeElement),
    "Tab must wrap within the dialog",
  )
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  verify(
    await control("analysis-import-open").evaluate(el => el === document.activeElement),
    "Closing the dialog must restore focus to the import button",
  )
  await control("analysis-import-open").click()
  await closeButton.click()
  await dialog.waitFor({ state: "hidden" })
  await control("analysis-import-open").click()
  await control("analysis-import-dialog").click({ position: { x: 5, y: 5 } })
  await dialog.waitFor({ state: "hidden" })
  await control("analysis-import-open").click()
  await control("analysis-import-path").fill(source + "-missing")
  await control("analysis-import-inspect").click()
  await page.waitForFunction(() =>
    document.querySelector('[automation-id="analysis-import-status"]').textContent.includes("ENOENT"),
  )
  verify(!(await control("analysis-import-commit").isVisible()), "Inspection errors must not enable import")
  await control("analysis-import-path").fill(source)
  let releaseInspection
  const inspectionGate = new Promise(resolve => { releaseInspection = resolve })
  await page.route("**/api/analysis/import/preview", async route => {
    const response = await route.fetch()
    await inspectionGate
    await route.fulfill({ response })
  }, { times: 1 })
  const inspecting = page.waitForRequest("**/api/analysis/import/preview")
  await control("analysis-import-inspect").click()
  await inspecting
  await control("analysis-import-cancel").click()
  await dialog.waitFor({ state: "hidden" })
  await control("analysis-import-open").click()
  const staleInspection = page.waitForResponse("**/api/analysis/import/preview")
  releaseInspection()
  await staleInspection
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  verify(
    !(await control("analysis-import-commit").isVisible()) &&
      !(await control("analysis-import-preview").innerText()),
    "A closed dialog's inspection must not populate a reopened dialog",
  )
  await control("analysis-import-inspect").click()
  await control("analysis-import-commit").waitFor()
  const preview = await control("analysis-import-preview").innerText()
  verify(
    preview.includes("Index: index.json found") &&
      preview.includes("Grouped: found") &&
      preview.includes("Final: final-analysis.md"),
    "Preview must detect the index and both optional artifacts",
  )
  verify(!preview.includes("Missing bundle-relative link"), "Import must not check Markdown links")
  await control("analysis-import-commit").click()
  verify(
    (await control("analysis-import-status").innerText()).includes(
      "Confirm the unverified",
    ),
    "Unverified imports require an explicit choice",
  )
  await control("analysis-import-unverified").check()
  const before = await info()
  await control("analysis-import-commit").click()
  await control("confirm-cancel").click()
  verify(await dialog.isVisible(), "Cancelling replacement must keep the import dialog open")
  verify(
    JSON.stringify((await info()).runs) === JSON.stringify(before.runs),
    "Cancel must preserve the existing analysis",
  )
  let releaseImport
  const importGate = new Promise(resolve => { releaseImport = resolve })
  await page.route("**/api/analysis/import", async route => {
    await importGate
    await route.continue()
  }, { times: 1 })
  await control("analysis-import-commit").click()
  const committed = page.waitForResponse((response) =>
    response.url().endsWith("/api/analysis/import"),
  )
  const importing = page.waitForRequest("**/api/analysis/import")
  await control("confirm-primary").click()
  await importing
  verify(
    await control("analysis-import-cancel").isDisabled() &&
      await closeButton.isDisabled(),
    "Closing must be disabled while importing",
  )
  await page.keyboard.press("Escape")
  verify(await dialog.isVisible(), "Escape must not close an in-progress import")
  releaseImport()
  verify((await committed).ok(), "Import failed")
  await page.waitForFunction(() =>
    document
      .querySelector('[automation-id="analysis-import-status"]')
      .textContent.includes("Import complete"),
  )
  await page.waitForFunction(
    () =>
      !document.querySelector('[automation-id="analysis-import-open"]')
        .disabled,
  )
  const imported = await info()
  await dialog.waitFor({ state: "hidden" })
  verify(
    imported.runs[0].analysisFileExists &&
      imported.runs[0].groupedAnalysisExists,
    "Imported final/grouped must appear in Info",
  )
  verify(
    imported.runs[0].analysisFile.endsWith("final-analysis.md"),
    "Final must use the canonical filename",
  )
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: "dark" })
    await control("analysis-import-open").click()
    verify(!(await control("analysis-import-commit").isVisible()), "Reopening must clear the old preview")
    const box = await control("analysis-import-path").boundingBox()
    verify(
      box && box.x >= 0 && box.x + box.width <= width + 1,
      "Import path must fit the viewport",
    )
    await control("analysis-import-cancel").click()
    await dialog.waitFor({ state: "hidden" })
  }
  await control("analysis-delete-output").click()
  verify(
    (await page.locator("#confirm-delete-message").innerText()).includes(
      "retained storage",
    ),
    "Output deletion must explain final retention",
  )
  const deleted = page.waitForResponse((response) =>
    response.url().endsWith("/api/analysis-run/output-dir"),
  )
  await control("confirm-primary").click()
  verify((await deleted).ok(), "Output deletion failed")
  const retained = await info()
  verify(
    !retained.runs[0].runDir &&
      retained.runs[0].analysisFileExists &&
      !retained.runs[0].groupedAnalysisExists,
    "Delete output must keep only the final",
  )
  await control("report-info-close").click()
  await control("report-info-open").first().click()
  await page.waitForFunction(() =>
    document
      .querySelector("#report-info-runs")
      .textContent.includes("final-analysis.md"),
  )
  verify(
    !(await page.locator("#vault-path").count()),
    "Vault setting must be removed",
  )
  await control("report-info-close").click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator("#settings-btn").click()
  verify(
    !(await page.getByText("Final analyses are stored inside their output directories.", { exact: false }).count()),
    "Preferences must not show the removed storage explanation",
  )
  return {
    import: "passed",
    cancellation: "passed",
    retention: "passed",
    darkAndMobile: "passed",
  }
}
