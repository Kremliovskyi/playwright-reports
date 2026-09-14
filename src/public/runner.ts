declare const Terminal: any;

document.addEventListener("DOMContentLoaded", () => {
  // Broadcast Channel for "Run Tests" button state
  const channel = new BroadcastChannel("runner_state");
  channel.postMessage({ state: "open" });
  channel.onmessage = (event) => {
    if (event.data.type === "ping")
      channel.postMessage({
        state: "open",
        requestId: event.data.requestId,
      });
  };
  window.addEventListener("beforeunload", () =>
    channel.postMessage({ state: "closed" }),
  );

  // Elements
  const projectSearch = document.getElementById(
    "project-search",
  ) as HTMLInputElement;
  const selectAllBtn = document.getElementById(
    "select-all-btn",
  ) as HTMLButtonElement;
  const selectNoneBtn = document.getElementById(
    "select-none-btn",
  ) as HTMLButtonElement;
  const selectedCountSpan = document.getElementById(
    "selected-count",
  ) as HTMLSpanElement;
  const projectGrid = document.getElementById("project-grid") as HTMLDivElement;
  const playwrightConfigSelect = document.getElementById(
    "playwright-config",
  ) as HTMLSelectElement;
  const browserstackConfigSelect = document.getElementById(
    "browserstack-config",
  ) as HTMLSelectElement;

  // Preset Elements
  const presetsBtn = document.getElementById(
    "presets-btn",
  ) as HTMLButtonElement;
  const presetsModal = document.getElementById(
    "presets-modal",
  ) as HTMLDivElement;
  const closePresetsBtn = document.getElementById(
    "close-presets-btn",
  ) as HTMLButtonElement;
  const presetsList = document.getElementById("presets-list") as HTMLDivElement;
  const savePresetBtn = document.getElementById(
    "save-preset-btn",
  ) as HTMLButtonElement;
  const newPresetName = document.getElementById(
    "new-preset-name",
  ) as HTMLInputElement;

  const optHeaded = document.getElementById("opt-headed") as HTMLInputElement;
  const optHeadless = document.getElementById(
    "opt-headless",
  ) as HTMLInputElement;
  const optUi = document.getElementById("opt-ui") as HTMLInputElement;
  const optDebug = document.getElementById("opt-debug") as HTMLInputElement;
  const optUpdateSnapshots = document.getElementById(
    "opt-update-snapshots",
  ) as HTMLInputElement;
  const optPodman = document.getElementById("opt-podman") as HTMLInputElement;
  const labelPodman = document.getElementById("label-podman") as HTMLLabelElement;
  const podmanInfoBtn = document.getElementById("podman-info-btn") as HTMLButtonElement;

  const optGrep = document.getElementById("opt-grep") as HTMLInputElement;
  const optRepeat = document.getElementById("opt-repeat") as HTMLInputElement;
  const optWorkers = document.getElementById("opt-workers") as HTMLInputElement;
  const optEnv = document.getElementById("opt-env") as HTMLInputElement;

  const optBrowserstack = document.getElementById(
    "opt-browserstack",
  ) as HTMLInputElement;
  const labelBrowserstack = document.getElementById(
    "label-browserstack",
  ) as HTMLLabelElement;
  const browserstackTooltip = document.getElementById(
    "browserstack-tooltip",
  ) as HTMLDivElement;
  const bsTipUsername = document.getElementById(
    "bs-tip-username",
  ) as HTMLLIElement;
  const bsTipKey = document.getElementById("bs-tip-key") as HTMLLIElement;
  const bsTipConfig = document.getElementById("bs-tip-config") as HTMLLIElement;

  // Elements that get disabled when BrowserStack is active
  const labelHeaded = document.getElementById(
    "label-headed",
  ) as HTMLLabelElement;
  const labelHeadless = document.getElementById(
    "label-headless",
  ) as HTMLLabelElement;
  const labelUi = document.getElementById("label-ui") as HTMLLabelElement;
  const labelDebug = document.getElementById("label-debug") as HTMLLabelElement;
  const labelUpdateSnapshots = document.getElementById(
    "label-update-snapshots",
  ) as HTMLLabelElement;
  const wrapperRepeat = document.getElementById(
    "wrapper-repeat",
  ) as HTMLDivElement;
  const wrapperWorkers = document.getElementById(
    "wrapper-workers",
  ) as HTMLDivElement;

  const runBtn = document.getElementById("run-btn") as HTMLButtonElement;
  const clearLogBtn = document.getElementById(
    "clear-log-btn",
  ) as HTMLButtonElement;

  // Dialog Elements
  const dialogModal = document.getElementById("dialog-modal") as HTMLDivElement;
  const dialogTitle = document.getElementById(
    "dialog-title",
  ) as HTMLHeadingElement;
  const dialogMessage = document.getElementById(
    "dialog-message",
  ) as HTMLParagraphElement;
  const dialogFooter = document.getElementById(
    "dialog-footer",
  ) as HTMLDivElement;
  const dialogHeaderCloseBtn = document.getElementById(
    "dialog-header-close-btn",
  ) as HTMLButtonElement;

  const showDialog = (
    message: string,
    options: { title?: string; confirm?: boolean } = {},
  ): Promise<boolean> => {
    dialogTitle.textContent =
      options.title || (options.confirm ? "Confirm" : "Notification");
    dialogMessage.textContent = message;
    dialogFooter.innerHTML = "";
    const previousFocus = document.activeElement as HTMLElement | null;

    return new Promise((resolve) => {
      const close = (result: boolean) => {
        dialogModal.classList.add("hidden");
        dialogModal.removeEventListener("keydown", onKeyDown);
        previousFocus?.focus();
        resolve(result);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") close(false);
        if (event.key === "Tab") {
          const buttons = Array.from(dialogModal.querySelectorAll<HTMLButtonElement>("button"));
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      };

      if (options.confirm) {
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = () => close(false);
        dialogFooter.appendChild(cancelBtn);
      }

      const okBtn = document.createElement("button");
      okBtn.className = "btn primary-btn";
      okBtn.textContent = options.confirm ? "Confirm" : "OK";
      okBtn.onclick = () => close(true);
      dialogFooter.appendChild(okBtn);

      dialogHeaderCloseBtn.onclick = () => close(false);

      dialogModal.classList.remove("hidden");
      dialogModal.addEventListener("keydown", onKeyDown);
      okBtn.focus();
    });
  };

  podmanInfoBtn.addEventListener("click", () => showDialog([
    "Install Podman (or Podman Desktop with the Podman engine) on the machine hosting this reports server. Put podman on its PATH; standard Windows install locations are also detected automatically.",
    "On Windows/macOS: run podman machine init once if needed, then podman machine start before running tests, or start the machine in Podman Desktop. Verify with podman info. On Linux, no Podman machine is normally needed.",
    "Prepare the official Playwright image matching the exact version in your project's npm lockfile. Example for 1.59.0: podman pull mcr.microsoft.com/playwright:v1.59.0-noble. A missing-image error gives the exact pull command for your project.",
    "Do not start a container manually. The runner creates a temporary container and removes it on completion or Stop. It runs npm ci (requires an npm lockfile and registry access) in isolated Linux node_modules, then runs tests headlessly. Host node_modules is not changed.",
    "The project is mounted read/write at /work. Keep report and snapshot paths inside the project; output and snapshot updates are saved back to it. Image snapshots use Linux baselines. Paths and dependencies must work on Linux.",
    "Only variables entered in System Env Variables are forwarded (plus runner defaults). For host services use host.containers.internal instead of localhost. Private registries may need project .npmrc settings and credentials supplied through environment variables.",
    "BrowserStack, Headed, UI Mode and Debug cannot be combined with Podman. Use only trusted tests and sites: the container runs as root with Chromium sandboxing disabled.",
    "Reference: https://playwright.dev/docs/docker",
  ].join("\n\n"), { title: "Run in Podman" }));

  const updatePodmanOptions = () => {
    const enabled = optPodman.checked;
    [optHeaded, optHeadless, optUi, optDebug].forEach((input) => {
      input.disabled = enabled;
      input.closest("label")?.classList.toggle("bs-disabled", enabled || optBrowserstack.checked);
    });
    if (enabled) {
      optHeaded.checked = false;
      optHeadless.checked = true;
      optUi.checked = false;
      optDebug.checked = false;
    }
  };
  optPodman.addEventListener("change", updatePodmanOptions);

  let allProjects: string[] = [];
  let selectedProjects: string[] = [];
  let playwrightConfigs: string[] = [];
  let browserstackConfigs: string[] = [];
  let selectedPlaywrightConfig = "";
  let selectedBrowserstackConfig = "";
  let projectLoadId = 0;
  let isRunning = false;

  let saveTimeout: any = null;

  // BrowserStack credentials are loaded from Preferences.
  let bsUsername = "";
  let bsAccessKey = "";

  // Saved state for options that get disabled during BrowserStack mode
  let savedHeaded = false;
  let savedHeadless = false;
  let savedUi = false;
  let savedDebug = false;
  let savedUpdateSnapshots = false;
  let savedPodman = false;
  let savedRepeat = "";
  let savedWorkers = "";

  const updateBrowserstackCheckbox = () => {
    const allSet = !!(
      bsUsername &&
      bsAccessKey &&
      selectedBrowserstackConfig &&
      browserstackConfigs.includes(selectedBrowserstackConfig)
    );

    if (allSet) {
      optBrowserstack.disabled = false;
      labelBrowserstack.classList.remove("is-disabled");
      browserstackTooltip.classList.remove("show-tooltip");
    } else {
      optBrowserstack.disabled = true;
      labelBrowserstack.classList.add("is-disabled");
      browserstackTooltip.classList.add("show-tooltip");
      if (optBrowserstack.checked) {
        optBrowserstack.checked = false;
        setBrowserstackDisabledOptions(false);
      }
    }
    browserstackConfigSelect.disabled =
      !browserstackConfigs.length || !optBrowserstack.checked;

    // Update tooltip indicators
    bsTipUsername.classList.toggle("is-set", !!bsUsername);
    bsTipKey.classList.toggle("is-set", !!bsAccessKey);
    bsTipConfig.classList.toggle("is-set", !!selectedBrowserstackConfig);
  };

  const setBrowserstackDisabledOptions = (disabled: boolean) => {
    const elements = [
      labelHeaded,
      labelHeadless,
      labelUi,
      labelDebug,
      labelUpdateSnapshots,
      labelPodman,
    ];
    const wrappers = [wrapperRepeat, wrapperWorkers];

    if (disabled) {
      // Save current state before disabling
      savedHeaded = optHeaded.checked;
      savedHeadless = optHeadless.checked;
      savedUi = optUi.checked;
      savedDebug = optDebug.checked;
      savedUpdateSnapshots = optUpdateSnapshots.checked;
      savedPodman = optPodman.checked;
      savedRepeat = optRepeat.value;
      savedWorkers = optWorkers.value;

      // Disable and clear
      optHeaded.checked = false;
      optHeadless.checked = false;
      optUi.checked = false;
      optDebug.checked = false;
      optUpdateSnapshots.checked = false;
      optPodman.checked = false;
      optRepeat.value = "";
      optWorkers.value = "";

      elements.forEach((el) => el.classList.add("bs-disabled"));
      wrappers.forEach((el) => el.classList.add("bs-disabled"));
    } else {
      // Restore saved state
      optHeaded.checked = savedHeaded;
      optHeadless.checked = savedHeadless;
      optUi.checked = savedUi;
      optDebug.checked = savedDebug;
      optUpdateSnapshots.checked = savedUpdateSnapshots;
      optPodman.checked = savedPodman;
      optRepeat.value = savedRepeat;
      optWorkers.value = savedWorkers;

      elements.forEach((el) => el.classList.remove("bs-disabled"));
      wrappers.forEach((el) => el.classList.remove("bs-disabled"));
    }
    optPodman.disabled = disabled;
    updatePodmanOptions();
  };

  optBrowserstack.addEventListener("change", () => {
    setBrowserstackDisabledOptions(optBrowserstack.checked);
    browserstackConfigSelect.disabled = !optBrowserstack.checked;
  });

  // Load state from backend config
  const loadState = async () => {
    try {
      const res = await fetch("/api/config");
      const config = await res.json();

      if (config.runnerOptions) {
        optHeaded.checked = config.runnerOptions.headed || false;
        optHeadless.checked = config.runnerOptions.headless || false;
        if (optHeadless.checked) optHeaded.checked = false;
        optUi.checked = config.runnerOptions.ui || false;
        optDebug.checked = config.runnerOptions.debug || false;
        optUpdateSnapshots.checked =
          config.runnerOptions.updateSnapshots || false;
        optPodman.checked = config.runnerOptions.usePodman || false;
        updatePodmanOptions();
        optGrep.value = config.runnerOptions.grep || "";
        optRepeat.value = config.runnerOptions.repeatEach || "";
        optWorkers.value = config.runnerOptions.workers || "";
        optEnv.value = config.runnerOptions.envVariables || "";
        selectedPlaywrightConfig = config.runnerOptions.playwrightConfig || "";
        selectedBrowserstackConfig =
          config.runnerOptions.browserstackConfig || "";
      }
      if (config.selectedProjects) {
        selectedProjects = config.selectedProjects || [];
      }

      // BrowserStack credentials
      bsUsername = config.browserstackUsername || "";
      bsAccessKey = config.browserstackAccessKey || "";
    } catch (e) {
      console.error("Failed to load options from backend:", e);
    }
  };

  // Save state to backend config with debounce
  const saveState = () => {
    if (saveTimeout) clearTimeout(saveTimeout);

    saveTimeout = setTimeout(async () => {
      const runnerOptions = {
        headed: optHeaded.checked,
        headless: optHeadless.checked,
        ui: optUi.checked,
        debug: optDebug.checked,
        updateSnapshots: optUpdateSnapshots.checked,
        usePodman: optPodman.checked,
        grep: optGrep.value,
        repeatEach: optRepeat.value,
        workers: optWorkers.value,
        envVariables: optEnv.value,
        playwrightConfig: selectedPlaywrightConfig,
        browserstackConfig: selectedBrowserstackConfig,
      };

      try {
        await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runnerOptions, selectedProjects }),
        });
      } catch (e) {
        console.error("Failed to save options to backend:", e);
      }
    }, 500); // 500ms debounce
  };

  optHeaded.addEventListener("change", () => {
    if (optHeaded.checked) optHeadless.checked = false;
  });
  optHeadless.addEventListener("change", () => {
    if (optHeadless.checked) {
      optHeaded.checked = false;
      optDebug.checked = false;
    }
  });
  optDebug.addEventListener("change", () => {
    if (optDebug.checked) optHeadless.checked = false;
  });

  [
    optHeaded,
    optHeadless,
    optUi,
    optDebug,
    optUpdateSnapshots,
    optPodman,
    optGrep,
    optRepeat,
    optWorkers,
    optEnv,
  ].forEach((el) => {
    el.addEventListener("change", saveState);
    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "text") {
      el.addEventListener("input", saveState);
    }
  });

  // Render Projects
  const renderProjects = () => {
    const query = projectSearch.value.toLowerCase().trim();
    const filtered = query
      ? allProjects.filter((p) => p.toLowerCase().includes(query))
      : [...allProjects];
    filtered.sort((a, b) => a.localeCompare(b));

    selectedCountSpan.textContent = `(${selectedProjects.length})`;
    projectGrid.innerHTML = "";

    if (filtered.length === 0) {
      projectGrid.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; width: 100%; text-align: center; padding: 20px; grid-column: 1 / -1;">No projects found</div>`;
      return;
    }

    filtered.forEach((p) => {
      const label = document.createElement("label");
      label.className = "checkbox-label";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedProjects.includes(p);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedProjects.push(p);
        else selectedProjects = selectedProjects.filter((sp) => sp !== p);
        saveState();
        selectedCountSpan.textContent = `(${selectedProjects.length})`;
      });

      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(" " + p));
      projectGrid.appendChild(label);
    });
  };

  projectSearch.addEventListener("input", renderProjects);

  selectAllBtn.addEventListener("click", () => {
    const query = projectSearch.value.toLowerCase().trim();
    const filtered = query
      ? allProjects.filter((p) => p.toLowerCase().includes(query))
      : [...allProjects];
    const newSelected = new Set(selectedProjects);
    filtered.forEach((p) => newSelected.add(p));
    selectedProjects = Array.from(newSelected);
    saveState();
    renderProjects();
  });

  selectNoneBtn.addEventListener("click", () => {
    const query = projectSearch.value.toLowerCase().trim();
    const filtered = query
      ? allProjects.filter((p) => p.toLowerCase().includes(query))
      : [...allProjects];
    const visibleSet = new Set(filtered);
    selectedProjects = selectedProjects.filter((p) => !visibleSet.has(p));
    saveState();
    renderProjects();
  });

  const renderConfigOptions = (
    select: HTMLSelectElement,
    configs: string[],
    selectedConfig: string,
  ) => {
    select.innerHTML = "";
    if (!configs.length) {
      const option = document.createElement("option");
      option.textContent = "No configs found";
      option.value = "";
      select.appendChild(option);
      select.disabled = true;
      return;
    }

    for (const config of configs) {
      const option = document.createElement("option");
      option.textContent = config;
      option.value = config;
      option.selected = config === selectedConfig;
      select.appendChild(option);
    }
    select.disabled = false;
  };

  const loadProjects = async () => {
    const loadId = ++projectLoadId;
    if (!selectedPlaywrightConfig) {
      allProjects = [];
      selectedProjects = [];
      renderProjects();
      return;
    }

    projectGrid.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; grid-column: 1 / -1;">Loading projects...</div>`;
    try {
      const response = await fetch(
        `/api/projects?config=${encodeURIComponent(selectedPlaywrightConfig)}`,
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Failed to load projects");
      if (loadId !== projectLoadId) return;
      allProjects = data.projects || [];
      selectedProjects = selectedProjects.filter((project) =>
        allProjects.includes(project),
      );
      renderProjects();
    } catch (error) {
      if (loadId !== projectLoadId) return;
      allProjects = [];
      selectedProjects = [];
      selectedCountSpan.textContent = "(0)";
      projectGrid.innerHTML = `<div style="color: var(--danger); font-size: 13px; grid-column: 1 / -1;">Error loading projects</div>`;
      console.error(error);
    }
  };

  const loadRunnerConfigs = async () => {
    const response = await fetch("/api/runner-configs");
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Failed to discover runner configs");

    playwrightConfigs = data.playwrightConfigs || [];
    browserstackConfigs = data.browserstackConfigs || [];
    const previousPlaywrightConfig = selectedPlaywrightConfig;
    const previousBrowserstackConfig = selectedBrowserstackConfig;
    if (!playwrightConfigs.includes(selectedPlaywrightConfig))
      selectedPlaywrightConfig = playwrightConfigs[0] || "";
    if (!browserstackConfigs.includes(selectedBrowserstackConfig))
      selectedBrowserstackConfig = browserstackConfigs[0] || "";

    renderConfigOptions(
      playwrightConfigSelect,
      playwrightConfigs,
      selectedPlaywrightConfig,
    );
    renderConfigOptions(
      browserstackConfigSelect,
      browserstackConfigs,
      selectedBrowserstackConfig,
    );
    updateBrowserstackCheckbox();
    await loadProjects();

    if (
      previousPlaywrightConfig !== selectedPlaywrightConfig ||
      previousBrowserstackConfig !== selectedBrowserstackConfig
    ) {
      saveState();
    }
  };

  playwrightConfigSelect.addEventListener("change", async () => {
    selectedPlaywrightConfig = playwrightConfigSelect.value;
    await loadProjects();
    saveState();
  });

  browserstackConfigSelect.addEventListener("change", () => {
    selectedBrowserstackConfig = browserstackConfigSelect.value;
    updateBrowserstackCheckbox();
    saveState();
  });

  const initializeRunner = async () => {
    try {
      await loadState();
      await loadRunnerConfigs();
    } catch (error) {
      playwrightConfigSelect.innerHTML = `<option value="">Config discovery failed</option>`;
      playwrightConfigSelect.disabled = true;
      browserstackConfigSelect.innerHTML = `<option value="">Config discovery failed</option>`;
      browserstackConfigSelect.disabled = true;
      projectGrid.innerHTML = `<div style="color: var(--danger); font-size: 13px; grid-column: 1 / -1;">Error discovering configs</div>`;
      console.error(error);
    }
  };

  void initializeRunner();

  // --- Presets Logic ---
  let currentPresets: any[] = [];

  const loadPresets = async () => {
    try {
      presetsList.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px;">Loading presets...</div>`;
      const res = await fetch("/api/presets");
      const data = await res.json();
      if (data.success) {
        currentPresets = data.presets || [];
        renderPresets();
      } else {
        presetsList.innerHTML = `<div style="color: var(--danger); font-size: 13px;">Error loading presets.</div>`;
      }
    } catch (err) {
      presetsList.innerHTML = `<div style="color: var(--danger); font-size: 13px;">Network error loading presets.</div>`;
    }
  };

  const renderPresets = () => {
    if (currentPresets.length === 0) {
      presetsList.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; font-style: italic;">No presets saved yet.</div>`;
      return;
    }

    presetsList.innerHTML = "";
    currentPresets.forEach((preset) => {
      const item = document.createElement("div");
      item.style.display = "flex";
      item.style.justifyContent = "space-between";
      item.style.alignItems = "center";
      item.style.padding = "8px 12px";
      item.style.background = "var(--bg-color)";
      item.style.border = "1px solid var(--border-color)";
      item.style.borderRadius = "var(--radius)";

      const infoDiv = document.createElement("div");
      infoDiv.style.flex = "1";
      infoDiv.innerHTML = `
                <div style="font-weight: 500; font-size: 14px;">${preset.name}</div>
                <div style="font-size: 12px; color: var(--text-muted);">${preset.projects?.length || 0} projects</div>
            `;

      const actionsDiv = document.createElement("div");
      actionsDiv.style.display = "flex";
      actionsDiv.style.gap = "10px";

      const applyBtn = document.createElement("button");
      applyBtn.className = "btn secondary-btn";
      applyBtn.style.padding = "4px 10px";
      applyBtn.style.fontSize = "12px";
      applyBtn.textContent = "Apply";
      applyBtn.onclick = async () => {
        const presetProjects = preset.projects || [];
        const missingProjects = presetProjects.filter(
          (p: string) => !allProjects.includes(p),
        );
        const validProjects = presetProjects.filter((p: string) =>
          allProjects.includes(p),
        );

        if (missingProjects.length > 0) {
          const message =
            `Some projects in this preset are no longer available in your Playwright config:\n\n` +
            missingProjects.map((p: string) => `  • ${p}`).join("\n") +
            ` \n\nOnly the remaining ${validProjects.length} projects will be applied. You might want to update or delete this preset.`;

          await showDialog(message, { title: "Preset Discrepancy" });
        }

        selectedProjects = [...validProjects];
        projectSearch.value = ""; // Clear search to show all appropriately
        renderProjects();
        saveState();
        presetsModal.classList.add("hidden");
      };

      const delBtn = document.createElement("button");
      delBtn.className = "btn-delete";
      delBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
            `;
      delBtn.onclick = async () => {
        if (
          await showDialog(`Delete preset "${preset.name}"?`, { confirm: true })
        ) {
          try {
            const res = await fetch(`/api/presets/${preset.id}`, {
              method: "DELETE",
            });
            if (res.ok) {
              loadPresets(); // refresh
            }
          } catch (e) {
            await showDialog("Failed to delete preset.");
          }
        }
      };

      actionsDiv.appendChild(applyBtn);
      actionsDiv.appendChild(delBtn);

      item.appendChild(infoDiv);
      item.appendChild(actionsDiv);
      presetsList.appendChild(item);
    });
  };

  presetsBtn.addEventListener("click", () => {
    presetsModal.classList.remove("hidden");
    newPresetName.value = ""; // clear input
    loadPresets();
  });

  closePresetsBtn.addEventListener("click", () => {
    presetsModal.classList.add("hidden");
  });

  savePresetBtn.addEventListener("click", async () => {
    const name = newPresetName.value.trim();
    if (!name) {
      await showDialog("Please enter a preset name.");
      return;
    }
    if (selectedProjects.length === 0) {
      await showDialog("No projects currently selected.");
      return;
    }

    savePresetBtn.disabled = true;
    savePresetBtn.textContent = "Saving...";

    try {
      const res = await fetch("/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, projects: selectedProjects }),
      });
      const data = await res.json();
      if (data.success) {
        newPresetName.value = "";
        loadPresets();
      } else {
        await showDialog(data.error || "Failed to save preset.");
      }
    } catch (err) {
      await showDialog("Network error saving preset.");
    } finally {
      savePresetBtn.disabled = false;
      savePresetBtn.textContent = "Save Current";
    }
  });

  // Close modal on click outside
  presetsModal.addEventListener("click", (e) => {
    if (e.target === presetsModal) presetsModal.classList.add("hidden");
  });

  // Initialize Terminal
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'Courier New', Courier, monospace",
    theme: { background: "#000000", foreground: "#ffffff" },
  });
  const fitAddon = new (window as any).FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  const terminalContainer = document.getElementById("terminal") as HTMLElement;
  term.open(terminalContainer);
  fitAddon.fit();
  window.addEventListener("resize", () => fitAddon.fit());
  term.writeln("Ready to run tests.");

  clearLogBtn.addEventListener("click", () => term.clear());

  let eventSource: EventSource | null = null;

  const setRunButtonState = (running: boolean) => {
    isRunning = running;
    if (running) {
      runBtn.textContent = "Stop Tests";
      runBtn.className = "run-btn btn-danger";
    } else {
      runBtn.textContent = "Run Tests";
      runBtn.className = "run-btn btn-primary";
    }
  };

  const connectSSE = () => {
    if (eventSource) eventSource.close();
    eventSource = new EventSource("/api/logs");

    eventSource.addEventListener("start", (e: any) => {
      const data = JSON.parse(e.data);
      term.writeln("\x1b[32m" + data + "\x1b[0m");
      setRunButtonState(true);
    });

    eventSource.addEventListener("output", (e: any) => {
      const data = JSON.parse(e.data);
      term.write(data.replace(/\n/g, "\r\n"));
    });

    eventSource.addEventListener("complete", () => {
      setRunButtonState(false);
    });

    eventSource.onerror = (e) => console.error("SSE Error", e);
  };

  connectSSE();

  runBtn.addEventListener("click", async () => {
    if (isRunning) {
      runBtn.disabled = true;
      try {
        const response = await fetch("/api/stop-tests", { method: "POST" });
        if (!response.ok) throw new Error((await response.json()).error || "Failed to stop tests");
      } catch (err: any) {
        term.writeln(
          "\x1b[31mError stopping tests: " + err.message + "\x1b[0m",
        );
      } finally {
        runBtn.disabled = false;
      }
      return;
    }

    if (!selectedPlaywrightConfig) {
      await showDialog("Playwright config has to be selected for test run");
      return;
    }
    if (allProjects.length > 0 && selectedProjects.length === 0) {
      await showDialog("Project has to be selected for test run");
      return;
    }

    term.clear();
    term.writeln("Starting tests...");

    const args: string[] = [];

    // Projects
    selectedProjects.forEach((p) => {
      args.push("--project", p);
    });

    // Options (skipped when BrowserStack is active — they're already disabled/cleared)
    if (optHeaded.checked) args.push("--headed");
    if (optUi.checked) args.push("--ui");
    if (optDebug.checked) args.push("--debug");
    if (optUpdateSnapshots.checked) args.push("--update-snapshots");

    if (optGrep.value) {
      // First escape regex special characters, then replace double quotes with a dot wildcard (.)
      // This completely sidesteps shell quoting nightmares by matching the quote via a regex dot instead.
      const escapedGrep = optGrep.value
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/"/g, ".");
      args.push("--grep", escapedGrep);
    }

    if (optRepeat.value) args.push(`--repeat-each=${optRepeat.value}`);
    if (optWorkers.value) args.push(`--workers=${optWorkers.value}`);

    // Custom Env mapping
    const env: Record<string, string> = {};
    if (optEnv.value) {
      optEnv.value.split(";").forEach((pair) => {
        const idx = pair.indexOf("=");
        if (idx !== -1) {
          const key = pair.substring(0, idx).trim();
          const value = pair.substring(idx + 1).trim();
          if (key) env[key] = value;
        }
      });
    }

    // BrowserStack mode
    const useBrowserstack = optBrowserstack.checked;
    if (useBrowserstack && !selectedBrowserstackConfig) {
      await showDialog("BrowserStack config has to be selected for this run");
      return;
    }

    runBtn.disabled = true;
    try {
      const response = await fetch("/api/run-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args,
          env,
          useBrowserstack,
          usePodman: optPodman.checked,
          headless: optHeadless.checked,
          playwrightConfig: selectedPlaywrightConfig,
          browserstackConfig: selectedBrowserstackConfig,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to start tests");
      // start is handled by SSE event 'start'
    } catch (err: any) {
      term.writeln("\x1b[31mError starting tests: " + err.message + "\x1b[0m");
    } finally {
      runBtn.disabled = false;
    }
  });
});
