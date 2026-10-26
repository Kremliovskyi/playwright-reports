(() => {
  if (!navigator.serviceWorker) return;

  const workers = navigator.serviceWorker;
  const scope = new URL(".", location.href).href;
  const workerUrl = new URL("sw.bundle.js", scope).href;
  const contextsUrl = new URL("contexts", scope).href;
  const nativeFetch = window.fetch.bind(window);
  const attemptedTraces = new Set<string>();
  const versionError = "The trace was created by a newer version of Playwright and is not supported by this version of the viewer.";
  const statusId = "playwright-reports-trace-recovery";
  const logPrefix = "[trace-viewer-recovery]";

  function showStatus(message: string): HTMLElement {
    let status = document.getElementById(statusId);
    if (!status) {
      status = document.createElement("div");
      status.id = statusId;
      status.setAttribute("role", "status");
      status.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:80vw;padding:10px 16px;border-radius:6px;background:#1f2937;color:#fff;font:13px system-ui;box-shadow:0 2px 8px #0006";
      document.body.append(status);
    }
    status.textContent = message;
    return status;
  }

  function updateController(previous: ServiceWorker): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let registration: ServiceWorkerRegistration | undefined;
      let settled = false;
      const observed = new Set<ServiceWorker>();
      const timer = setTimeout(
        () => finish(false, new Error("Worker update timed out after 5000 ms.")),
        5000,
      );

      function finish(updated: boolean, error?: unknown): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        workers.removeEventListener("controllerchange", observe);
        registration?.removeEventListener("updatefound", observe);
        for (const worker of observed) worker.removeEventListener("statechange", observe);
        if (error) reject(error);
        else resolve(updated);
      }

      function observe(): void {
        for (const worker of [registration?.installing, registration?.waiting, registration?.active, workers.controller]) {
          if (!worker || observed.has(worker)) continue;
          observed.add(worker);
          worker.addEventListener("statechange", observe);
        }
        const controller = workers.controller;
        if (
          controller && controller !== previous && controller === registration?.active &&
          controller.scriptURL === workerUrl && controller.state === "activated"
        )
          finish(true);
      }

      workers.addEventListener("controllerchange", observe);
      void workers.getRegistration(scope).then(async current => {
        if (settled) return;
        if (
          !current || current.scope !== scope || previous.scriptURL !== workerUrl ||
          [current.active, current.waiting, current.installing].some(worker => worker && worker.scriptURL !== workerUrl)
        ) {
          finish(false);
          return;
        }
        registration = current;
        current.addEventListener("updatefound", observe);
        observe();
        if (settled) return;
        if (current.installing || current.waiting || current.active !== previous) return;
        await current.update();
        if (settled) return;
        observe();
        if (!current.installing && !current.waiting && current.active === previous)
          finish(false);
      }).catch(error => finish(false, error));
    });
  }

  window.fetch = async (input, init) => {
    const previous = workers.controller;
    const response = await nativeFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const trace = url.searchParams.get("trace");
    if (url.origin + url.pathname !== contextsUrl || method.toUpperCase() !== "GET" || !trace)
      return response;
    if (response.ok) {
      document.getElementById(statusId)?.remove();
      return response;
    }
    if (
      response.status !== 500 || attemptedTraces.has(trace) ||
      !response.headers.get("content-type")?.toLowerCase().includes("application/json")
    )
      return response;

    let body: unknown;
    try {
      body = await response.clone().json();
    } catch (error) {
      console.warn(logPrefix, "Could not inspect the trace loading error; preserving the response.", error);
      return response;
    }
    if (!body || typeof body !== "object" || !("error" in body) ||
      typeof body.error !== "string" || !body.error.includes(versionError))
      return response;

    attemptedTraces.add(trace);
    console.warn(logPrefix, "Trace version mismatch; checking the viewer worker.", { scope, worker: previous?.scriptURL });
    showStatus("Checking for an updated Playwright trace viewer...");
    try {
      if (previous && await updateController(previous)) {
        // Use the original fetch directly so a failed retry cannot start another recovery.
        const retry = await nativeFetch(input, init);
        if (retry.ok) {
          console.info(logPrefix, "Trace recovered after the replacement worker took control.", { scope });
          const message = "Trace loaded after updating its Playwright viewer.";
          const status = showStatus(message);
          setTimeout(() => { if (status.textContent === message) status.remove(); }, 4000);
          return retry;
        }
        console.warn(logPrefix, "The single trace retry failed; preserving the original error.", { status: retry.status });
      } else {
        console.warn(logPrefix, "No matching replacement worker took control; preserving the original error.", { scope });
      }
    } catch (error) {
      console.warn(logPrefix, "Automatic trace viewer recovery failed; preserving the original error.", error);
    }
    showStatus("Automatic viewer recovery could not resolve this mismatch. The original error is shown below.");
    return response;
  };
})();
