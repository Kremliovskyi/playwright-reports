async (page) => {
  const origin = new URL(page.url()).origin;
  page = await page.context().newPage();
  const verify = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  const runs = [];
  let config = {
    runnerOptions: {
      grep: "legacy, admin | guest",
      playwrightConfig: "playwright.config.ts",
      browserstackConfig: "browserstack.yml",
      repeatEach: "2",
      workers: "3",
      envVariables: "ENV=UAT",
    },
    selectedProjects: ["chromium"],
    browserstackUsername: "fixture-user",
    browserstackAccessKey: "fixture-key",
  };

  try {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      window.Terminal = class {
        loadAddon() {}
        open() {}
        writeln() {}
        write() {}
        clear() {}
      };
      window.FitAddon = { FitAddon: class { fit() {} } };
      window.EventSource = class {
        addEventListener() {}
        close() {}
      };
    });
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        await route.fulfill({ body: "" });
      } else {
        await route.fallback();
      }
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/config") {
        if (request.method() === "POST")
          config = { ...config, ...request.postDataJSON() };
        await route.fulfill({ json: config });
      } else if (pathname === "/api/runner-configs") {
        await route.fulfill({
          json: {
            playwrightConfigs: ["playwright.config.ts"],
            browserstackConfigs: ["browserstack.yml"],
          },
        });
      } else if (pathname === "/api/projects") {
        await route.fulfill({ json: { projects: ["chromium"] } });
      } else if (pathname === "/api/run-tests") {
        runs.push(request.postDataJSON());
        await route.fulfill({ json: { success: true } });
      } else {
        errors.push(`Unexpected API request: ${request.method()} ${pathname}`);
        await route.fulfill({ status: 500, json: { error: "Unexpected request" } });
      }
    });

    const input = page.getByRole("textbox", { name: "Test titles", exact: true });
    const chips = page.locator(".title-chip-edit");
    const removeButtons = page.locator(".title-chip-remove");
    const checkChips = async (expected) => verify(
      JSON.stringify(await chips.allTextContents()) === JSON.stringify(expected),
      `Expected chips: ${JSON.stringify(expected)}`,
    );
    const saved = async (grep) => {
      if (config.runnerOptions.grep !== grep) {
        await page.waitForResponse((response) =>
          new URL(response.url()).pathname === "/api/config" &&
          response.request().method() === "POST" &&
          response.request().postDataJSON().runnerOptions.grep === grep,
        );
      }
      verify(config.runnerOptions.grep === grep, "All entries must be persisted");
    };
    const ready = () => page.getByRole("checkbox", { name: "chromium", exact: true }).waitFor();
    const run = async () => {
      const response = page.waitForResponse("**/api/run-tests");
      await page.getByRole("button", { name: "Run Tests", exact: true }).click();
      verify((await response).ok(), "Run request must succeed");
      return runs.at(-1);
    };
    const grepFrom = (request) => {
      verify(request.args.filter((arg) => arg === "--grep").length === 1, "Exactly one grep argument");
      return request.args[request.args.indexOf("--grep") + 1];
    };
    const clear = async () => {
      await input.fill("");
      while (await removeButtons.count()) await removeButtons.first().click();
      await checkChips([]);
    };
    const paste = (text) => input.evaluate((element, value) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData, bubbles: true, cancelable: true,
      }));
    }, text);

    await page.goto(`${origin}/runner.html`);
    await ready();
    await checkChips(["legacy, admin | guest"]);
    verify(
      grepFrom(await run()) === "legacy, admin \\| guest",
      "Legacy filters must remain a single literal entry",
    );

    await clear();
    const unfiltered = await run();
    verify(!unfiltered.args.includes("--grep"), "No entries must omit grep");
    verify(
      JSON.stringify(unfiltered.args) ===
        JSON.stringify(["--project", "chromium", "--repeat-each=2", "--workers=3"]),
      "Other runner arguments must remain intact",
    );
    verify(unfiltered.env.ENV === "UAT", "Other runner settings must remain intact");

    await input.fill("  login (admin)  ");
    verify(grepFrom(await run()) === "login \\(admin\\)", "Run must include uncommitted text");
    await checkChips(["login (admin)"]);
    verify(await input.inputValue() === "", "Run must commit the draft");
    await input.fill("  unfinished title  ");
    await saved("login (admin)\nunfinished title");
    await page.reload();
    await ready();
    await checkChips(["login (admin)", "unfinished title"]);

    await clear();
    await paste("  login (admin)\r\n\nreset password\rcheckout\nlogin (admin)\n   ");
    await checkChips(["login (admin)", "reset password", "checkout"]);
    await input.fill(" login (admin) ");
    await input.press("Enter");
    await checkChips(["login (admin)", "reset password", "checkout"]);
    const pattern = grepFrom(await run());
    verify(
      pattern === "login \\(admin\\)|reset password|checkout",
      "Titles must be escaped separately, then combined with OR",
    );
    const matcher = new RegExp(pattern);
    for (const title of ["login (admin)", "reset password", "checkout"])
      verify(matcher.test(`suite ${title} succeeds`), `Must include ${title}`);
    verify(!matcher.test("unrelated test"), "No blank alternative may select unrelated tests");
    verify(!matcher.test("login admin"), "Regex punctuation must remain literal");

    await input.fill("new draft");
    await page.getByRole("button", { name: "Edit title filter: login (admin)", exact: true }).click();
    await checkChips(["reset password", "checkout", "new draft"]);
    verify(await input.inputValue() === "login (admin)", "Click must load the chip for editing");
    verify(await input.evaluate((element) => element === document.activeElement), "Editing must focus input");
    await input.fill("login (guest)");
    await input.press("Enter");
    await checkChips(["reset password", "checkout", "new draft", "login (guest)"]);

    const removeDraft = page.getByRole("button", { name: "Remove title filter: new draft", exact: true });
    await removeDraft.focus();
    await page.keyboard.press("Space");
    await checkChips(["reset password", "checkout", "login (guest)"]);
    verify(await input.evaluate((element) => element === document.activeElement), "Removal must keep keyboard focus usable");
    await input.press("Backspace");
    await checkChips(["reset password", "checkout"]);
    verify(await input.inputValue() === "login (guest)", "Backspace must edit the last chip");
    await input.press("Enter");
    await saved("reset password\ncheckout\nlogin (guest)");
    await page.reload();
    await ready();
    await checkChips(["reset password", "checkout", "login (guest)"]);

    await clear();
    await input.fill("prefix OLD suffix");
    await input.evaluate((element) => element.setSelectionRange(7, 10));
    await paste("first\nsecond");
    await checkChips(["prefix first", "second suffix"]);
    await input.fill("composing");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await checkChips(["prefix first", "second suffix"]);
    verify(await input.inputValue() === "composing", "IME confirmation must not prematurely commit");
    await input.press("Enter");
    await checkChips(["prefix first", "second suffix", "composing"]);

    await clear();
    const literalTitle = 'checkout "VIP" | guest, v1.2';
    await input.fill(literalTitle);
    await input.press("Enter");
    await input.fill("<b>literal</b>");
    await input.press("Enter");
    await checkChips([literalTitle, "<b>literal</b>"]);
    verify(await page.locator("#title-chips b").count() === 0, "Titles must be rendered as text");
    const literalPattern = grepFrom(await run());
    verify(!literalPattern.includes('"'), "Quotes must not enter shell arguments literally");
    verify(new RegExp(literalPattern).test(literalTitle), "Quoted title must match");
    verify(!new RegExp(literalPattern).test("checkout XVIPY | guest, v1.2"), "Quotes must not become wildcards");
    verify(!new RegExp(literalPattern).test("guest, v1.2"), "User-entered pipes must remain literal");

    await page.locator("#opt-browserstack").check();
    const browserstackRun = await run();
    verify(browserstackRun.useBrowserstack && grepFrom(browserstackRun) === literalPattern,
      "BrowserStack must receive the same combined filter");
    await page.locator("#opt-browserstack").uncheck();
    await page.locator("#opt-podman").check();
    const podmanRun = await run();
    verify(podmanRun.usePodman && grepFrom(podmanRun) === literalPattern,
      "Podman must receive the same combined filter");
    await page.locator("#opt-podman").uncheck();

    await input.fill("a-long-unbroken-title".repeat(15));
    await input.press("Enter");
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      verify(await page.locator(".title-filter").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth &&
          element.scrollWidth <= element.clientWidth &&
          [...element.querySelectorAll("button, input")].every((child) => {
            const rect = child.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right;
          });
      }), `Filter and long chips must fit at ${width}px without horizontal overflow`);
    }

    await clear();
    await saved("");
    await page.reload();
    await ready();
    await checkChips([]);
    verify(!((await run()).args.includes("--grep")), "Removing all entries must persist no filter");
    verify(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
    return {
      passed: true,
      runRequests: runs.length,
      checks: [
        "legacy filter", "unfiltered run", "draft included on Run", "draft persistence",
        "multiline paste", "deduplication", "literal OR pattern", "editing with draft",
        "keyboard removal", "Backspace editing", "reload persistence", "paste selection",
        "IME input", "literal quotes and pipes", "text-only rendering",
        "BrowserStack", "Podman", "responsive long chips", "persisted clearing",
      ],
    };
  } finally {
    await page.close();
  }
}
