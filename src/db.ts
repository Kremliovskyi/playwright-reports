import Database from 'better-sqlite3';
import path from 'path';

// --- Interfaces ---
export interface AppConfig {
  id: string;
  currentPath: string;
  archivePath: string;
  projectPath: string;
  runnerOptions: {
    headed: boolean;
    ui: boolean;
    debug: boolean;
    updateSnapshots: boolean;
    grep: string;
    repeatEach: string;
    workers: string;
    envVariables: string;
  };
  selectedProjects: string[];
}

export interface Preset {
  id: string;
  configId: string;
  name: string;
  projects: string[];
}

const DEFAULT_RUNNER_OPTIONS = {
  headed: false,
  ui: false,
  debug: false,
  updateSnapshots: false,
  grep: '',
  repeatEach: '',
  workers: '',
  envVariables: ''
};

export const DEFAULT_CONFIG: AppConfig = {
  id: 'default',
  currentPath: "",
  archivePath: "",
  projectPath: "",
  runnerOptions: { ...DEFAULT_RUNNER_OPTIONS },
  selectedProjects: []
};

// --- Database Connection ---
const DB_PATH = path.join(__dirname, '..', 'app.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    id TEXT PRIMARY KEY,
    currentPath TEXT NOT NULL DEFAULT '',
    archivePath TEXT NOT NULL DEFAULT '',
    projectPath TEXT NOT NULL DEFAULT '',
    runnerOptions TEXT NOT NULL DEFAULT '{}',
    selectedProjects TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY,
    configId TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    projects TEXT NOT NULL DEFAULT '[]'
  );
`);

// Ensure default config row exists
const existing = db.prepare('SELECT id FROM config WHERE id = ?').get('default');
if (!existing) {
  db.prepare('INSERT INTO config (id, currentPath, archivePath, projectPath, runnerOptions, selectedProjects) VALUES (?, ?, ?, ?, ?, ?)')
    .run('default', '', '', '', JSON.stringify(DEFAULT_RUNNER_OPTIONS), '[]');
}

// --- Config Operations ---
export const getConfig = (): AppConfig => {
  const row = db.prepare('SELECT * FROM config WHERE id = ?').get('default') as any;
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    id: row.id,
    currentPath: row.currentPath,
    archivePath: row.archivePath,
    projectPath: row.projectPath,
    runnerOptions: JSON.parse(row.runnerOptions),
    selectedProjects: JSON.parse(row.selectedProjects)
  };
};

export const updateConfig = (config: AppConfig): void => {
  db.prepare('UPDATE config SET currentPath = ?, archivePath = ?, projectPath = ?, runnerOptions = ?, selectedProjects = ? WHERE id = ?')
    .run(config.currentPath, config.archivePath, config.projectPath, JSON.stringify(config.runnerOptions), JSON.stringify(config.selectedProjects), 'default');
};

// --- Preset Operations ---
export const getPresets = (configId: string = 'default'): Preset[] => {
  const rows = db.prepare('SELECT * FROM presets WHERE configId = ?').all(configId) as any[];
  return rows.map(row => ({
    id: row.id,
    configId: row.configId,
    name: row.name,
    projects: JSON.parse(row.projects)
  }));
};

export const addPreset = (preset: Preset): void => {
  db.prepare('INSERT INTO presets (id, configId, name, projects) VALUES (?, ?, ?, ?)')
    .run(preset.id, preset.configId, preset.name, JSON.stringify(preset.projects));
};

export const deletePreset = (id: string): void => {
  db.prepare('DELETE FROM presets WHERE id = ?').run(id);
};
