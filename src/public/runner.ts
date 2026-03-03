declare const Terminal: any;

document.addEventListener('DOMContentLoaded', () => {
    // Broadcast Channel for "Run Tests" button state
    const channel = new BroadcastChannel('runner_state');
    channel.postMessage({ state: 'open' });
    channel.onmessage = (event) => {
        if (event.data.type === 'ping') channel.postMessage({ state: 'open' });
    };
    window.addEventListener('beforeunload', () => channel.postMessage({ state: 'closed' }));

    // Elements
    const projectSearch = document.getElementById('project-search') as HTMLInputElement;
    const selectAllBtn = document.getElementById('select-all-btn') as HTMLButtonElement;
    const selectNoneBtn = document.getElementById('select-none-btn') as HTMLButtonElement;
    const selectedCountSpan = document.getElementById('selected-count') as HTMLSpanElement;
    const projectGrid = document.getElementById('project-grid') as HTMLDivElement;
    
    const optHeaded = document.getElementById('opt-headed') as HTMLInputElement;
    const optUi = document.getElementById('opt-ui') as HTMLInputElement;
    const optDebug = document.getElementById('opt-debug') as HTMLInputElement;
    const optUpdateSnapshots = document.getElementById('opt-update-snapshots') as HTMLInputElement;
    
    const optGrep = document.getElementById('opt-grep') as HTMLInputElement;
    const optRepeat = document.getElementById('opt-repeat') as HTMLInputElement;
    const optWorkers = document.getElementById('opt-workers') as HTMLInputElement;
    const optEnv = document.getElementById('opt-env') as HTMLInputElement;
    
    const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
    const clearLogBtn = document.getElementById('clear-log-btn') as HTMLButtonElement;
    
    let allProjects: string[] = [];
    let selectedProjects: string[] = [];
    let isRunning = false;

    let saveTimeout: any = null;

    // Load state from backend config
    const loadState = async () => {
        try {
            const res = await fetch('/api/config');
            const config = await res.json();
            
            if (config.runnerOptions) {
                optHeaded.checked = config.runnerOptions.headed || false;
                optUi.checked = config.runnerOptions.ui || false;
                optDebug.checked = config.runnerOptions.debug || false;
                optUpdateSnapshots.checked = config.runnerOptions.updateSnapshots || false;
                optGrep.value = config.runnerOptions.grep || '';
                optRepeat.value = config.runnerOptions.repeatEach || '';
                optWorkers.value = config.runnerOptions.workers || '';
                optEnv.value = config.runnerOptions.envVariables || '';
            }
            if (config.selectedProjects) {
                selectedProjects = config.selectedProjects || [];
            }
            
            // Re-render projects if they were loaded before state
            if (allProjects.length > 0) {
                 selectedProjects = selectedProjects.filter(p => allProjects.includes(p));
                 renderProjects();
            }
        } catch (e) {
            console.error('Failed to load options from backend:', e);
        }
    };
    
    // Save state to backend config with debounce
    const saveState = () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        
        saveTimeout = setTimeout(async () => {
            const runnerOptions = {
                headed: optHeaded.checked,
                ui: optUi.checked,
                debug: optDebug.checked,
                updateSnapshots: optUpdateSnapshots.checked,
                grep: optGrep.value,
                repeatEach: optRepeat.value,
                workers: optWorkers.value,
                envVariables: optEnv.value
            };
            
            try {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ runnerOptions, selectedProjects })
                });
            } catch (e) {
                console.error('Failed to save options to backend:', e);
            }
        }, 500); // 500ms debounce
    };

    [optHeaded, optUi, optDebug, optUpdateSnapshots, optGrep, optRepeat, optWorkers, optEnv].forEach(el => {
        el.addEventListener('change', saveState);
        if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text') {
             el.addEventListener('input', saveState);
        }
    });

    loadState();

    // Render Projects
    const renderProjects = () => {
        const query = projectSearch.value.toLowerCase().trim();
        const filtered = query ? allProjects.filter(p => p.toLowerCase().includes(query)) : [...allProjects];
        filtered.sort((a, b) => a.localeCompare(b));
        
        selectedCountSpan.textContent = `(${selectedProjects.length})`;
        projectGrid.innerHTML = '';
        
        if (filtered.length === 0) {
            projectGrid.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px; width: 100%; text-align: center; padding: 20px; grid-column: 1 / -1;">No projects found</div>`;
            return;
        }

        filtered.forEach(p => {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selectedProjects.includes(p);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selectedProjects.push(p);
                else selectedProjects = selectedProjects.filter(sp => sp !== p);
                saveState();
                selectedCountSpan.textContent = `(${selectedProjects.length})`;
            });
            
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(' ' + p));
            projectGrid.appendChild(label);
        });
    };

    projectSearch.addEventListener('input', renderProjects);

    selectAllBtn.addEventListener('click', () => {
        const query = projectSearch.value.toLowerCase().trim();
        const filtered = query ? allProjects.filter(p => p.toLowerCase().includes(query)) : [...allProjects];
        const newSelected = new Set(selectedProjects);
        filtered.forEach(p => newSelected.add(p));
        selectedProjects = Array.from(newSelected);
        saveState();
        renderProjects();
    });

    selectNoneBtn.addEventListener('click', () => {
        const query = projectSearch.value.toLowerCase().trim();
        const filtered = query ? allProjects.filter(p => p.toLowerCase().includes(query)) : [...allProjects];
        const visibleSet = new Set(filtered);
        selectedProjects = selectedProjects.filter(p => !visibleSet.has(p));
        saveState();
        renderProjects();
    });

    // Load initial projects
    fetch('/api/projects')
        .then(res => res.json())
        .then(data => {
            allProjects = data.projects || [];
             // Only keep selected projects that actually exist
            selectedProjects = selectedProjects.filter(p => allProjects.includes(p));
            renderProjects();
        })
        .catch(err => {
            projectGrid.innerHTML = `<div style="color: var(--danger); font-size: 13px; grid-column: 1 / -1;">Error loading projects</div>`;
        });

    // Initialize Terminal
    const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Courier New', Courier, monospace",
        theme: { background: '#000000', foreground: '#ffffff' }
    });
    const fitAddon = new (window as any).FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    const terminalContainer = document.getElementById('terminal') as HTMLElement;
    term.open(terminalContainer);
    fitAddon.fit();
    window.addEventListener('resize', () => fitAddon.fit());
    term.writeln('Ready to run tests.');

    clearLogBtn.addEventListener('click', () => term.clear());

    let eventSource: EventSource | null = null;

    const setRunButtonState = (running: boolean) => {
        isRunning = running;
        if (running) {
            runBtn.textContent = 'Stop Tests';
            runBtn.className = 'run-btn btn-danger';
        } else {
            runBtn.textContent = 'Run Tests';
            runBtn.className = 'run-btn btn-primary';
        }
    };

    const connectSSE = () => {
        if (eventSource) eventSource.close();
        eventSource = new EventSource('/api/logs');
        
        eventSource.addEventListener('start', (e: any) => {
            const data = JSON.parse(e.data);
            term.writeln('\x1b[32m' + data + '\x1b[0m');
            setRunButtonState(true);
        });

        eventSource.addEventListener('output', (e: any) => {
            const data = JSON.parse(e.data);
            term.write(data.replace(/\n/g, '\r\n'));
        });

        eventSource.addEventListener('complete', () => {
            setRunButtonState(false);
        });
        
        eventSource.onerror = (e) => console.error('SSE Error', e);
    };

    connectSSE();

    runBtn.addEventListener('click', async () => {
        if (isRunning) {
            runBtn.disabled = true;
            try {
                await fetch('/api/stop-tests', { method: 'POST' });
            } catch (err: any) {
                 term.writeln('\x1b[31mError stopping tests: ' + err.message + '\x1b[0m');
            } finally {
                runBtn.disabled = false;
            }
            return;
        }

        if (selectedProjects.length === 0) {
            alert('Project has to be selected for test run');
            return;
        }

        term.clear();
        term.writeln('Starting tests...');
        
        const args: string[] = [];
        
        // Projects
        selectedProjects.forEach(p => {
          args.push('--project', p);
        });
        
        // Options
        if (optHeaded.checked) args.push('--headed');
        if (optUi.checked) args.push('--ui');
        if (optDebug.checked) args.push('--debug');
        if (optUpdateSnapshots.checked) args.push('--update-snapshots');
        
        if (optGrep.value) {
           const escapedGrep = optGrep.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
           args.push('--grep', escapedGrep);
        }
        
        if (optRepeat.value) args.push(`--repeat-each=${optRepeat.value}`);
        if (optWorkers.value) args.push(`--workers=${optWorkers.value}`);
        
        // Custom Env mapping
        const env: Record<string, string> = {};
        if (optEnv.value) {
            optEnv.value.split(';').forEach(pair => {
                const idx = pair.indexOf('=');
                if (idx !== -1) {
                    const key = pair.substring(0, idx).trim();
                    const value = pair.substring(idx + 1).trim();
                    if (key) env[key] = value;
                }
            });
        }

        runBtn.disabled = true;
        try {
            await fetch('/api/run-tests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ args, env })
            });
            // start is handled by SSE event 'start'
        } catch (err: any) {
            term.writeln('\x1b[31mError starting tests: ' + err.message + '\x1b[0m');
        } finally {
            runBtn.disabled = false;
        }
    });
});
