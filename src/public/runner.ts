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
    
    // Preset Elements
    const presetsBtn = document.getElementById('presets-btn') as HTMLButtonElement;
    const presetsModal = document.getElementById('presets-modal') as HTMLDivElement;
    const closePresetsBtn = document.getElementById('close-presets-btn') as HTMLButtonElement;
    const presetsList = document.getElementById('presets-list') as HTMLDivElement;
    const savePresetBtn = document.getElementById('save-preset-btn') as HTMLButtonElement;
    const newPresetName = document.getElementById('new-preset-name') as HTMLInputElement;

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

    // Dialog Elements
    const dialogModal = document.getElementById('dialog-modal') as HTMLDivElement;
    const dialogTitle = document.getElementById('dialog-title') as HTMLHeadingElement;
    const dialogMessage = document.getElementById('dialog-message') as HTMLParagraphElement;
    const dialogFooter = document.getElementById('dialog-footer') as HTMLDivElement;
    const dialogHeaderCloseBtn = document.getElementById('dialog-header-close-btn') as HTMLButtonElement;

    const showDialog = (message: string, options: { title?: string, confirm?: boolean } = {}): Promise<boolean> => {
        dialogTitle.textContent = options.title || (options.confirm ? 'Confirm' : 'Notification');
        dialogMessage.textContent = message;
        dialogFooter.innerHTML = '';

        return new Promise((resolve) => {
            const close = (result: boolean) => {
                dialogModal.classList.add('hidden');
                resolve(result);
            };

            if (options.confirm) {
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.onclick = () => close(false);
                dialogFooter.appendChild(cancelBtn);
            }

            const okBtn = document.createElement('button');
            okBtn.className = 'btn primary-btn';
            okBtn.textContent = options.confirm ? 'Confirm' : 'OK';
            okBtn.onclick = () => close(true);
            dialogFooter.appendChild(okBtn);

            dialogHeaderCloseBtn.onclick = () => close(false);
            
            dialogModal.classList.remove('hidden');
        });
    };
    
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

    // --- Presets Logic ---
    let currentPresets: any[] = [];

    const loadPresets = async () => {
        try {
            presetsList.innerHTML = `<div style="color: var(--text-secondary); font-size: 13px;">Loading presets...</div>`;
            const res = await fetch('/api/presets');
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

        presetsList.innerHTML = '';
        currentPresets.forEach(preset => {
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.padding = '8px 12px';
            item.style.background = 'var(--bg-color)';
            item.style.border = '1px solid var(--border-color)';
            item.style.borderRadius = 'var(--radius)';
            
            const infoDiv = document.createElement('div');
            infoDiv.style.flex = '1';
            infoDiv.innerHTML = `
                <div style="font-weight: 500; font-size: 14px;">${preset.name}</div>
                <div style="font-size: 12px; color: var(--text-muted);">${preset.projects?.length || 0} projects</div>
            `;
            
            const actionsDiv = document.createElement('div');
            actionsDiv.style.display = 'flex';
            actionsDiv.style.gap = '10px';
            
            const applyBtn = document.createElement('button');
            applyBtn.className = 'btn secondary-btn';
            applyBtn.style.padding = '4px 10px';
            applyBtn.style.fontSize = '12px';
            applyBtn.textContent = 'Apply';
            applyBtn.onclick = async () => {
                const presetProjects = preset.projects || [];
                const missingProjects = presetProjects.filter((p: string) => !allProjects.includes(p));
                const validProjects = presetProjects.filter((p: string) => allProjects.includes(p));

                if (missingProjects.length > 0) {
                    const message = `Some projects in this preset are no longer available in your Playwright config:\n\n` + 
                                    missingProjects.map((p: string) => `  • ${p}`).join('\n') + 
                                    ` \n\nOnly the remaining ${validProjects.length} projects will be applied. You might want to update or delete this preset.`;
                    
                    await showDialog(message, { title: 'Preset Discrepancy' });
                }

                selectedProjects = [...validProjects];
                projectSearch.value = ''; // Clear search to show all appropriately
                renderProjects();
                saveState();
                presetsModal.classList.add('hidden');
            };

            const delBtn = document.createElement('button');
            delBtn.className = 'btn-delete';
            delBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
            `;
            delBtn.onclick = async () => {
                if(await showDialog(`Delete preset "${preset.name}"?`, { confirm: true })) {
                    try {
                        const res = await fetch(`/api/presets/${preset.id}`, { method: 'DELETE' });
                        if(res.ok) {
                            loadPresets(); // refresh
                        }
                    } catch (e) {
                         await showDialog('Failed to delete preset.');
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

    presetsBtn.addEventListener('click', () => {
        presetsModal.classList.remove('hidden');
        newPresetName.value = ''; // clear input
        loadPresets();
    });

    closePresetsBtn.addEventListener('click', () => {
        presetsModal.classList.add('hidden');
    });

    savePresetBtn.addEventListener('click', async () => {
        const name = newPresetName.value.trim();
        if (!name) {
            await showDialog('Please enter a preset name.');
            return;
        }
        if (selectedProjects.length === 0) {
            await showDialog('No projects currently selected.');
            return;
        }

        savePresetBtn.disabled = true;
        savePresetBtn.textContent = 'Saving...';

        try {
            const res = await fetch('/api/presets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, projects: selectedProjects })
            });
            const data = await res.json();
            if (data.success) {
                newPresetName.value = '';
                loadPresets();
            } else {
                await showDialog(data.error || 'Failed to save preset.');
            }
        } catch (err) {
            await showDialog('Network error saving preset.');
        } finally {
            savePresetBtn.disabled = false;
            savePresetBtn.textContent = 'Save Current';
        }
    });

    // Close modal on click outside
    presetsModal.addEventListener('click', (e) => {
        if (e.target === presetsModal) presetsModal.classList.add('hidden');
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
            await showDialog('Project has to be selected for test run');
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
           // First escape regex special characters, then replace double quotes with a dot wildcard (.)
           // This completely sidesteps shell quoting nightmares by matching the quote via a regex dot instead.
           const escapedGrep = optGrep.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '.');
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
