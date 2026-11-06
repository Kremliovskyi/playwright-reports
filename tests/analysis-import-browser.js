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
  await control("analysis-import-path").fill(source)
  await control("analysis-import-inspect").click()
  await control("analysis-import-commit").waitFor()
  const preview = await control("analysis-import-preview").innerText()
  verify(
    preview.includes("Grouped: found") &&
      preview.includes("Final: final-analysis.md"),
    "Preview must detect both artifacts",
  )
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
  verify(
    JSON.stringify((await info()).runs) === JSON.stringify(before.runs),
    "Cancel must preserve the existing analysis",
  )
  await control("analysis-import-commit").click()
  const committed = page.waitForResponse((response) =>
    response.url().endsWith("/api/analysis/import"),
  )
  await control("confirm-primary").click()
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
  verify(
    imported.runs[0].analysisFileExists &&
      imported.runs[0].groupedAnalysisExists,
    "Imported final/grouped must appear in Info",
  )
  verify(
    imported.runs[0].analysisFile.endsWith("final-analysis.md"),
    "Final must use the canonical filename",
  )
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: "dark" })
    await control("analysis-import-open").click()
    const box = await control("analysis-import-path").boundingBox()
    verify(
      box && box.x >= 0 && box.x + box.width <= width + 1,
      "Import path must fit the viewport",
    )
    await control("analysis-import-open").click()
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
  return {
    import: "passed",
    cancellation: "passed",
    retention: "passed",
    darkAndMobile: "passed",
  }
}
