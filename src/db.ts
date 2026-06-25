import Database from 'better-sqlite3';
import path from 'path';

// --- Interfaces ---
export interface AppConfig {
  id: string;
  currentPath: string;
  archivePath: string;
  projectPath: string;
  vaultPath: string;
  browserstackUsername: string;
  browserstackAccessKey: string;
  browserstackConfig: string;
  copilotToken: string;
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

export interface ReportRecord {
  id: string;
  dateCreated: string;
  metadata: string;
  reportPath: string;
}

export interface AnalysisRun {
  id: string;
  reportId: string;
  runDir: string;
  runName: string;
  createdAt: string;
}

export interface ReportSearchFilters {
  query?: string;
  selectedDates?: string[];
  rangeStart?: string;
  rangeEnd?: string;
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
  vaultPath: "",
  browserstackUsername: "",
  browserstackAccessKey: "",
  browserstackConfig: "",
  copilotToken: "",
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
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    dateCreated TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '',
    reportPath TEXT NOT NULL DEFAULT ''
  );
`);

// Migration: add vaultPath column if missing
const configColumns = db.prepare("PRAGMA table_info(config)").all() as { name: string }[];
if (!configColumns.some(c => c.name === 'vaultPath')) {
  db.exec("ALTER TABLE config ADD COLUMN vaultPath TEXT NOT NULL DEFAULT ''");
}

// Migration: add BrowserStack columns if missing
if (!configColumns.some(c => c.name === 'browserstackUsername')) {
  db.exec("ALTER TABLE config ADD COLUMN browserstackUsername TEXT NOT NULL DEFAULT ''");
}
if (!configColumns.some(c => c.name === 'browserstackAccessKey')) {
  db.exec("ALTER TABLE config ADD COLUMN browserstackAccessKey TEXT NOT NULL DEFAULT ''");
}
if (!configColumns.some(c => c.name === 'browserstackConfig')) {
  db.exec("ALTER TABLE config ADD COLUMN browserstackConfig TEXT NOT NULL DEFAULT ''");
}
if (!configColumns.some(c => c.name === 'copilotToken')) {
  db.exec("ALTER TABLE config ADD COLUMN copilotToken TEXT NOT NULL DEFAULT ''");
}

// Migration: add analysis_runs table (one report -> many failure-analysis run directories)
db.exec(`
  CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY,
    reportId TEXT NOT NULL,
    runDir TEXT NOT NULL UNIQUE,
    runName TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_analysis_runs_reportId ON analysis_runs(reportId);
`);

// Ensure default config row exists
const existing = db.prepare('SELECT id FROM config WHERE id = ?').get('default');
if (!existing) {
  db.prepare('INSERT INTO config (id, currentPath, archivePath, projectPath, vaultPath, runnerOptions, selectedProjects) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('default', '', '', '', '', JSON.stringify(DEFAULT_RUNNER_OPTIONS), '[]');
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
    vaultPath: row.vaultPath || '',
    browserstackUsername: row.browserstackUsername || '',
    browserstackAccessKey: row.browserstackAccessKey || '',
    browserstackConfig: row.browserstackConfig || '',
    copilotToken: row.copilotToken || '',
    runnerOptions: JSON.parse(row.runnerOptions),
    selectedProjects: JSON.parse(row.selectedProjects)
  };
};

export const updateConfig = (config: AppConfig): void => {
  db.prepare('UPDATE config SET currentPath = ?, archivePath = ?, projectPath = ?, vaultPath = ?, browserstackUsername = ?, browserstackAccessKey = ?, browserstackConfig = ?, copilotToken = ?, runnerOptions = ?, selectedProjects = ? WHERE id = ?')
    .run(config.currentPath, config.archivePath, config.projectPath, config.vaultPath, config.browserstackUsername, config.browserstackAccessKey, config.browserstackConfig, config.copilotToken, JSON.stringify(config.runnerOptions), JSON.stringify(config.selectedProjects), 'default');
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

// --- Report Operations ---
export const upsertReport = (report: ReportRecord): void => {
  db.prepare(
    `INSERT INTO reports (id, dateCreated, metadata, reportPath)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       dateCreated = excluded.dateCreated,
       reportPath = excluded.reportPath`
  ).run(report.id, report.dateCreated, report.metadata, report.reportPath);
};

export const getReport = (id: string): ReportRecord | undefined => {
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRecord | undefined;
};

export const getAllReports = (): ReportRecord[] => {
  return db.prepare('SELECT * FROM reports').all() as ReportRecord[];
};

export const updateReportMetadata = (id: string, metadata: string): void => {
  db.prepare('UPDATE reports SET metadata = ? WHERE id = ?').run(metadata, id);
};

export const deleteReportRecord = (id: string): void => {
  db.prepare('DELETE FROM reports WHERE id = ?').run(id);
};

export const updateReportId = (oldId: string, newId: string, newPath: string): void => {
  db.prepare('UPDATE reports SET id = ?, reportPath = ? WHERE id = ?').run(newId, newPath, oldId);
};

// --- Analysis Run Operations ---
export const addAnalysisRun = (run: AnalysisRun): void => {
  db.prepare(
    `INSERT OR IGNORE INTO analysis_runs (id, reportId, runDir, runName, createdAt)
     VALUES (?, ?, ?, ?, ?)`
  ).run(run.id, run.reportId, run.runDir, run.runName, run.createdAt);
};

export const getAnalysisRuns = (reportId: string): AnalysisRun[] => {
  return db.prepare('SELECT * FROM analysis_runs WHERE reportId = ? ORDER BY createdAt DESC').all(reportId) as AnalysisRun[];
};

export const getAllAnalysisRuns = (): AnalysisRun[] => {
  return db.prepare('SELECT * FROM analysis_runs ORDER BY createdAt DESC').all() as AnalysisRun[];
};

export const deleteAnalysisRunsByReport = (reportId: string): void => {
  db.prepare('DELETE FROM analysis_runs WHERE reportId = ?').run(reportId);
};

export const renameAnalysisRunsReport = (oldReportId: string, newReportId: string): void => {
  db.prepare('UPDATE analysis_runs SET reportId = ? WHERE reportId = ?').run(newReportId, oldReportId);
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const normalizeSearchText = (value?: string): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 256);
};

const splitSearchQueryTokens = (value: string): string[] => value
  .split(/\s+/)
  .filter(Boolean);

const normalizeDateInput = (value?: string): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!DATE_ONLY_PATTERN.test(trimmed)) {
    throw new Error(`Invalid date value: ${value}`);
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }

  return trimmed;
};

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

export const searchReports = (filters: ReportSearchFilters): ReportRecord[] => {
  const normalizedQuery = normalizeSearchText(filters.query);
  const normalizedSelectedDates = Array.from(new Set((filters.selectedDates || [])
    .map(value => normalizeDateInput(value))
    .filter((value): value is string => Boolean(value))));
  const normalizedRangeStart = normalizeDateInput(filters.rangeStart);
  const normalizedRangeEnd = normalizeDateInput(filters.rangeEnd);

  if (normalizedRangeStart && normalizedRangeEnd && normalizedRangeStart > normalizedRangeEnd) {
    throw new Error('Range start must be on or before range end');
  }

  const whereClauses: string[] = [];
  const params: Array<string> = [];

  if (normalizedQuery) {
    const queryTokens = splitSearchQueryTokens(normalizedQuery);
    if (queryTokens.length > 0) {
      whereClauses.push(`(${queryTokens.map(() => `metadata LIKE ? ESCAPE '\\' COLLATE NOCASE`).join(' AND ')})`);
      params.push(...queryTokens.map(token => `%${escapeLikePattern(token)}%`));
    }
  }

  const dateClauses: string[] = [];
  if (normalizedSelectedDates.length > 0) {
    const placeholders = normalizedSelectedDates.map(() => '?').join(', ');
    dateClauses.push(`substr(dateCreated, 1, 10) IN (${placeholders})`);
    params.push(...normalizedSelectedDates);
  }

  if (normalizedRangeStart && normalizedRangeEnd) {
    dateClauses.push(`substr(dateCreated, 1, 10) BETWEEN ? AND ?`);
    params.push(normalizedRangeStart, normalizedRangeEnd);
  } else if (normalizedRangeStart) {
    dateClauses.push(`substr(dateCreated, 1, 10) >= ?`);
    params.push(normalizedRangeStart);
  } else if (normalizedRangeEnd) {
    dateClauses.push(`substr(dateCreated, 1, 10) <= ?`);
    params.push(normalizedRangeEnd);
  }

  if (dateClauses.length > 0) {
    whereClauses.push(`(${dateClauses.join(' OR ')})`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM reports ${whereSql} ORDER BY dateCreated DESC`
  ).all(...params) as ReportRecord[];
};
