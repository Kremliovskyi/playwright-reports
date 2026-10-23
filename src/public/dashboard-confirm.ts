namespace DashboardConfirm {
  export function create() {
    const confirmDeleteModal = document.getElementById(
      "confirm-delete-modal",
    ) as HTMLElement;
    const closeConfirmDeleteModalBtn = document.getElementById(
      "close-confirm-delete-modal-btn",
    ) as HTMLButtonElement;
    const confirmDeleteTitle = document.getElementById(
      "confirm-delete-title",
    ) as HTMLElement;
    const confirmDeleteMessage = document.getElementById(
      "confirm-delete-message",
    ) as HTMLElement;
    const confirmDeletePath = document.getElementById(
      "confirm-delete-path",
    ) as HTMLElement;
    const confirmDeleteCancelBtn = document.getElementById(
      "confirm-delete-cancel-btn",
    ) as HTMLButtonElement;
    const confirmDeleteConfirmBtn = document.getElementById(
      "confirm-delete-confirm-btn",
    ) as HTMLButtonElement;

    // Generic promise-based confirmation.
    let confirmResolve: ((value: boolean) => void) | null = null;
    let confirmPreviousFocus: HTMLElement | null = null;
    const confirmOptions = document.getElementById("confirm-delete-options")!;
    const openConfirm = (opts: {
      title: string;
      message: string;
      path?: string;
      confirmLabel?: string;
      choices?: {
        label: string;
        path: string;
        disabled: boolean;
        reason: string;
      }[];
      onSelect?: (index: number) => void;
    }): Promise<boolean> => {
      if (confirmResolve) return Promise.resolve(false);
      confirmPreviousFocus = document.activeElement as HTMLElement;
      confirmDeleteTitle.textContent = opts.title;
      confirmDeleteMessage.textContent = opts.message;
      confirmDeletePath.textContent = opts.path || "";
      confirmDeletePath.classList.toggle("hidden", !opts.path);
      confirmDeleteConfirmBtn.textContent = opts.confirmLabel || "Delete";
      confirmDeleteConfirmBtn.disabled = !!opts.choices;
      confirmOptions.replaceChildren();
      confirmOptions.classList.toggle("hidden", !opts.choices);
      if (opts.choices) {
        const label = document.createElement("label");
        label.textContent = "Analysis to keep";
        label.htmlFor = "confirm-analysis-selection";
        const select = document.createElement("select");
        select.id = "confirm-analysis-selection";
        select.style.maxWidth = "100%";
        select.add(new Option("Select analysis", ""));
        opts.choices.forEach((choice, index) => {
          const option = new Option(choice.label, String(index));
          option.disabled = choice.disabled;
          select.add(option);
        });
        const issues = document.createElement("p");
        issues.textContent = [
          ...new Set(
            opts.choices
              .filter((choice) => choice.disabled)
              .map((choice) => choice.reason),
          ),
        ].join(" ");
        select.addEventListener("change", () => {
          const choice =
            select.value === "" ? undefined : opts.choices![Number(select.value)];
          confirmDeleteConfirmBtn.disabled = !choice || choice.disabled;
          confirmDeletePath.textContent = choice?.path || opts.path || "";
          confirmDeletePath.classList.toggle(
            "hidden",
            !confirmDeletePath.textContent,
          );
          if (choice) opts.onSelect?.(Number(select.value));
        });
        confirmOptions.append(label, select, issues);
      }
      confirmDeleteModal.classList.remove("hidden");
      confirmDeleteCancelBtn.focus();
      return new Promise<boolean>((resolve) => {
        confirmResolve = resolve;
      });
    };
    const closeConfirm = (result: boolean) => {
      confirmDeleteModal.classList.add("hidden");
      if (confirmResolve) {
        confirmResolve(result);
        confirmResolve = null;
      }
      confirmPreviousFocus?.focus();
    };
    confirmDeleteConfirmBtn.addEventListener("click", () => closeConfirm(true));
    confirmDeleteCancelBtn.addEventListener("click", () => closeConfirm(false));
    closeConfirmDeleteModalBtn.addEventListener("click", () =>
      closeConfirm(false),
    );
    confirmDeleteModal.addEventListener("click", (event) => {
      if (event.target === confirmDeleteModal) closeConfirm(false);
    });
    confirmDeleteModal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeConfirm(false);
      }
      if (event.key === "Tab") {
        const elements = Array.from(
          confirmDeleteModal.querySelectorAll<HTMLElement>(
            "button:not(:disabled), select",
          ),
        ).filter((element) => element.offsetParent !== null);
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    });

    return openConfirm;
  }
}
