namespace Preferences {
  export function create(deps: {
    checkRunnerOpen: () => Promise<boolean>;
    showErrorDialog: (title: string, error: unknown, options?: { closeLabel?: string }) => void;
    setCopilotModelFieldValue: (role: "small" | "big", value: string) => void;
  }): void {
    const { checkRunnerOpen, showErrorDialog, setCopilotModelFieldValue } = deps;
    const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
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
    const copilotTokenInput = document.getElementById(
      "copilot-token-input",
    ) as HTMLInputElement;
    const modalError = document.getElementById("modal-error") as HTMLElement;

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

    // --- Modal Logic ---

    const openModal = async () => {
      modalError.classList.add("hidden");
      settingsModal.classList.remove("hidden");
      saveModalBtn.disabled = true;

      try {
        const response = await fetch("/api/config");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load preferences");
        currentPathInput.value = data.currentPath || "";
        archivePathInput.value = data.archivePath || "";
        projectPathInput.value = data.projectPath || "";
        vaultPathInput.value = data.vaultPath || "";
        browserstackUsernameInput.value = data.browserstackUsername || "";
        browserstackKeyInput.value = data.browserstackAccessKey || "";
        copilotTokenInput.value = data.copilotToken || "";
        setCopilotModelFieldValue("small", data.copilotModel || "");
        setCopilotModelFieldValue("big", data.copilotBigModel || "");
        saveModalBtn.disabled = false;
      } catch (err) {
        console.error("Failed to load config:", err);
        modalError.textContent = err instanceof Error ? err.message : String(err);
        modalError.classList.remove("hidden");
      }
    };

    const closeModal = () => {
      settingsModal.classList.add("hidden");
    };

    settingsBtn.addEventListener("click", openModal);
    closeModalBtn.addEventListener("click", closeModal);
    cancelModalBtn.addEventListener("click", closeModal);

    // Intentionally not closing on backdrop click as requested
    // User must use standard close/cancel/save buttons

    saveModalBtn.addEventListener("click", async () => {
      saveModalBtn.disabled = true;
      if (await checkRunnerOpen()) {
        showErrorDialog(
          "Runner is open",
          "Please close the runner before changing preferences.",
          { closeLabel: "Close" },
        );
        saveModalBtn.disabled = false;
        return;
      }

      const currentPath = currentPathInput.value.trim();
      const archivePath = archivePathInput.value.trim();
      const projectPath = projectPathInput.value.trim();
      const vaultPath = vaultPathInput.value.trim();
      const browserstackUsername = browserstackUsernameInput.value.trim();
      const browserstackAccessKey = browserstackKeyInput.value.trim();
      const copilotToken = copilotTokenInput.value.trim();

      modalError.classList.add("hidden");
      saveModalBtn.textContent = "Saving...";

      try {
        await Api.save("/api/config", {
          currentPath,
          archivePath,
          projectPath,
          vaultPath,
          browserstackUsername,
          browserstackAccessKey,
          copilotToken,
        });

        window.location.reload();
      } catch (err: any) {
        modalError.textContent = err.message;
        modalError.classList.remove("hidden");
      } finally {
        saveModalBtn.disabled = false;
        saveModalBtn.textContent = "Save changes and reload";
      }
    });


  }
}
