async (page) => {
  const verify = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const report = (id, scope) => ({
    id,
    uuid: id,
    name: id,
    path: `/reports/${scope}/${id}/index.html`,
    createdAt: "2026-10-09T08:00:00.000Z",
    metadata: "",
  });
  let catalog;
  let mutations;
  let catalogReads;
  const errors = [];
  const onError = (error) => errors.push(error.message);
  const routeApi = async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/analysis-runs") {
      await route.fulfill({ json: { runs: {} } });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/config") {
      await route.fulfill({ json: { projectPath: "" } });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/copilot-status") {
      await route.fulfill({
        json: {
          ok: false,
          authenticated: false,
          error: "Copilot is disabled in this browser test",
        },
      });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/reports") {
      catalogReads++;
      await route.fulfill({ json: catalog });
      return;
    }
    if (
      request.method() === "POST" &&
      ["/api/archive", "/api/delete"].includes(pathname)
    ) {
      const { reportPath } = request.postDataJSON();
      mutations.push({ pathname, reportPath });
      const source = [...catalog.current, ...catalog.archive].find(
        (entry) => entry.path === reportPath,
      );
      verify(source, `Unknown report mutation: ${reportPath}`);
      catalog.current = catalog.current.filter(
        (entry) => entry.path !== reportPath,
      );
      catalog.archive = catalog.archive.filter(
        (entry) => entry.path !== reportPath,
      );
      if (pathname === "/api/archive")
        catalog.archive.unshift(report(source.id, "archive"));
      await route.fulfill({ json: { success: true } });
      return;
    }
    errors.push(`Unexpected API request: ${request.method()} ${pathname}`);
    await route.fulfill({
      status: 500,
      json: { error: "Unexpected test API request" },
    });
  };
  const reset = async (archived = 0, current = 3) => {
    catalog = {
      current: Array.from({ length: current }, (_, index) =>
        report(`current-${index}`, "current"),
      ),
      archive: Array.from({ length: archived }, (_, index) =>
        report(`archived-${index}`, "archive"),
      ),
      configStatus: { hasCurrent: true, hasArchive: true },
    };
    mutations = [];
    catalogReads = 0;
    await page.reload();
    await row(0).waitFor();
  };
  const row = (index) =>
    page.locator(
      `#current-tbody .report-row[data-path="/reports/current/current-${index}/index.html"]`,
    );
  const dialog = page.getByRole("alertdialog");
  const archiveButton = row(0).getByRole("button", { name: "Archive Report" });
  const openSingle = async () => {
    await archiveButton.click();
    await dialog.waitFor();
    verify(
      (await dialog.innerText()).includes(
        "Are you sure you want to archive this report?",
      ),
      "Single archive must ask for confirmation",
    );
    verify(
      (await dialog.locator("#confirm-delete-path").innerText()) ===
        "/reports/current/current-0/index.html",
      "Confirmation must identify the report",
    );
  };
  const openBulk = async () => {
    await page.locator('.bulk-menu-trigger[data-target="current"]').click();
    await page
      .getByRole("menuitem", { name: "Archive selected", exact: true })
      .click();
    await dialog.waitFor();
  };
  const confirmSingle = () =>
    dialog.getByRole("button", { name: "Archive", exact: true }).click();
  const verifyDialogSpacing = async (modal) => {
    const layout = await modal.evaluate((element) => {
      const content = element.querySelector(".modal-content");
      const body = element.querySelector(".modal-body");
      const padding = (node) => {
        const style = getComputedStyle(node);
        return {
          top: parseFloat(style.paddingTop),
          right: parseFloat(style.paddingRight),
          bottom: parseFloat(style.paddingBottom),
          left: parseFloat(style.paddingLeft),
        };
      };
      const bounds = content.getBoundingClientRect();
      return {
        body: padding(body),
        header: padding(element.querySelector(".modal-header")),
        footer: padding(element.querySelector(".modal-footer")),
        fits:
          bounds.x >= 0 &&
          bounds.right <= window.innerWidth &&
          bounds.y >= 0 &&
          bounds.bottom <= window.innerHeight,
        overflows:
          content.scrollWidth > content.clientWidth ||
          body.scrollWidth > body.clientWidth,
      };
    });
    verify(
      layout.fits && !layout.overflows,
      "Dialog must fit without horizontal overflow",
    );
    for (const area of [layout.body, layout.header, layout.footer]) {
      verify(
        area.top >= 24 &&
          area.bottom >= 24 &&
          area.left >= 16 &&
          area.right >= 16,
        "Dialog sections must have comfortable inner padding",
      );
      verify(
        area.left === layout.body.left && area.right === layout.body.right,
        "Header, content and actions must have aligned side margins",
      );
    }
  };
  page.on("pageerror", onError);
  await page.route("**/api/**", routeApi);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await reset();
    await row(0).getByRole("button", { name: "More actions" }).click();
    await row(0).getByRole("button", { name: "Delete Report" }).click();
    const deleteDialog = page.locator("#delete-modal");
    await deleteDialog.waitFor();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await verifyDialogSpacing(deleteDialog);
    }
    await page.locator("#cancel-delete-btn").click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const dismiss of ["Cancel", "Escape", "Close", "Backdrop"]) {
      await openSingle();
      verify(
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .evaluate((element) => element === document.activeElement),
        "Cancel must receive initial focus",
      );
      if (dismiss === "Escape") await page.keyboard.press("Escape");
      else if (dismiss === "Backdrop")
        await dialog.click({ position: { x: 5, y: 5 } });
      else
        await dialog.getByRole("button", { name: dismiss, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      verify(
        mutations.length === 0 && catalogReads === 1,
        `${dismiss} must not archive reports or start capacity cleanup`,
      );
      verify(
        await archiveButton.evaluate(
          (element) => element === document.activeElement,
        ),
        "Dismissal must restore focus to the archive button",
      );
    }
    await openSingle();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await verifyDialogSpacing(dialog);
    }
    const pathPadding = await dialog
      .locator("#confirm-delete-path")
      .evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft));
    verify(pathPadding >= 16, "Report paths must have inner breathing room");
    await confirmSingle();
    await row(0).waitFor({ state: "hidden" });
    verify(
      mutations.length === 1 && mutations[0].pathname === "/api/archive",
      "Single confirmation must archive exactly once",
    );

    await page.setViewportSize({ width: 1440, height: 1000 });
    await reset();
    await row(0).locator(".row-select-checkbox").check();
    await openBulk();
    verify(
      await dialog
        .getByRole("button", { name: "Archive", exact: true })
        .isVisible(),
      "A single bulk selection must use the singular confirmation",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await row(1).locator(".row-select-checkbox").check();
    await openBulk();
    verify(
      (await dialog.locator("#confirm-delete-path").innerText()).split("\n")
        .length === 2,
      "Bulk confirmation must list exactly the selected reports",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    verify(
      mutations.length === 0 &&
        (await page.locator("#current-tbody input:checked").count()) === 2,
      "Bulk cancel must preserve reports and selection",
    );
    await openBulk();
    await dialog
      .getByRole("button", { name: "Archive 2 Reports", exact: true })
      .click();
    await row(0).waitFor({ state: "hidden" });
    verify(
      mutations.length === 2 &&
        mutations.every((mutation) => mutation.pathname === "/api/archive") &&
        catalog.current.length === 1 &&
        catalog.current[0].id === "current-2",
      "Bulk confirmation must archive only the selected reports",
    );

    await reset(20);
    await openSingle();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    verify(
      mutations.length === 0 && catalogReads === 1,
      "Cancel must preserve a full archive",
    );
    await openSingle();
    await confirmSingle();
    await page.locator("#archive-limit-modal").waitFor();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await verifyDialogSpacing(page.locator("#archive-limit-modal"));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    verify(mutations.length === 0, "Pruning must require its own confirmation");
    await page.locator("#cancel-archive-limit-btn").click();
    verify(mutations.length === 0, "Canceling pruning must cancel archiving");
    await openSingle();
    await confirmSingle();
    await page.locator("#confirm-archive-limit-btn").click();
    await row(0).waitFor({ state: "hidden" });
    verify(
      mutations.length === 6 &&
        mutations
          .slice(0, 5)
          .every((mutation) => mutation.pathname === "/api/delete") &&
        mutations[5].pathname === "/api/archive" &&
        catalog.archive.length === 16,
      "Confirmed capacity cleanup must still prune five reports before archiving",
    );

    await reset(0, 21);
    await page.locator('.select-all-btn[data-target="current"]').click();
    await openBulk();
    await dialog
      .getByRole("button", { name: "Archive 21 Reports", exact: true })
      .click();
    await page.locator("#archive-limit-modal").waitFor();
    verify(
      mutations.length === 0 &&
        !(await page.locator("#confirm-archive-limit-btn").isVisible()),
      "Oversized selections must remain blocked",
    );
    await page.locator("#cancel-archive-limit-btn").click();
    verify(errors.length === 0, errors.join("\n"));
    return {
      dismissalPreservesReports: true,
      singleAndBulkConfirmation: true,
      capacityCleanupPreserved: true,
      oversizedSelectionBlocked: true,
      mobileDialogFits: true,
      dialogSpacing: true,
    }
  } finally {
    await page.unroute("**/api/**", routeApi);
    page.off("pageerror", onError);
  }
};
