import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AnalysisRun } from "./db";

export interface ArtifactRoots {
  currentPath: string;
  archivePath: string;
  vaultPath: string;
}

export class ArtifactError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function assertOwnedPath(root: string, target: string): void {
  if (!root || !target)
    throw new ArtifactError(
      "UNSAFE_ARTIFACT_PATH",
      "Artifact storage is not configured.",
    );
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new ArtifactError(
      "UNSAFE_ARTIFACT_PATH",
      `Artifact is outside its managed directory: ${target}`,
    );
  let ancestor = resolved;
  while (ancestor !== path.dirname(ancestor)) {
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink())
        throw new ArtifactError(
          "UNSAFE_ARTIFACT_PATH",
          `Symbolic links cannot be removed as managed artifacts: ${ancestor}`,
        );
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if (ancestor === base) break;
    ancestor = path.dirname(ancestor);
  }
}

export const contentVersion = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

function inspectArtifact(root: string, target: string, directory: boolean) {
  assertOwnedPath(root, target);
  try {
    const stat = fs.statSync(target);
    if (directory ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`Unexpected artifact type: ${target}`);
    return {
      path: path.resolve(target),
      version: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${
        directory
          ? ["index.json", "grouped-analysis.md"]
              .map((name) => {
                const file = path.join(target, name);
                return fs.existsSync(file)
                  ? contentVersion(fs.readFileSync(file, "utf8"))
                  : "";
              })
              .join(":")
          : contentVersion(fs.readFileSync(target, "utf8"))
      }`,
    };
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function analysisInventory(roots: ArtifactRoots, runs: AnalysisRun[]) {
  const issues: string[] = [];
  const entries = runs.map((run) => {
    let output: ReturnType<typeof inspectArtifact> = null;
    const notes: NonNullable<ReturnType<typeof inspectArtifact>>[] = [];
    try {
      if (run.runDir)
        output = inspectArtifact(
          roots.currentPath ? path.join(roots.currentPath, "tmp") : "",
          run.runDir,
          true,
        );
      if (path.basename(run.runName) !== run.runName || !run.runName)
        throw new Error(`Invalid analysis name: ${run.runName}`);
      const noteRoots = [
        roots.vaultPath,
        roots.archivePath ? path.join(roots.archivePath, "analysis") : "",
      ].filter(Boolean);
      for (const root of new Set(noteRoots)) {
        const note = inspectArtifact(
          root,
          path.join(root, run.runName + ".md"),
          false,
        );
        if (note && !notes.some((existing) => existing.path === note.path))
          notes.push(note);
      }
    } catch (error: any) {
      issues.push(error.message);
    }
    return {
      id: run.id,
      runName: run.runName,
      createdAt: run.createdAt,
      output,
      notes,
    };
  });
  const outputs = new Set(
    entries.flatMap((entry) => (entry.output ? [entry.output.path] : [])),
  );
  const notes = new Set(
    entries.flatMap((entry) => entry.notes.map((note) => note.path)),
  );
  const duplicated = outputs.size > 1 || notes.size > 1;
  const choices = entries.map((entry) => {
    const keepPaths = [
      ...(entry.output ? [entry.output.path] : []),
      ...entry.notes.map((note) => note.path),
    ];
    const removePaths = [...outputs, ...notes].filter(
      (target) => !keepPaths.includes(target),
    );
    let blockedReason = issues.join("\n");
    if (!duplicated)
      blockedReason ||=
        "No distinct duplicate artifacts were found. Existing records require manual review.";
    if (outputs.size && !entry.output)
      blockedReason ||= "This selection would remove every output directory.";
    if (notes.size && !entry.notes.length)
      blockedReason ||=
        "This selection would remove every saved analysis file.";
    if (entry.notes.length > 1)
      blockedReason ||=
        "This analysis has multiple saved notes. Review them individually before consolidation.";
    for (const removed of removePaths) {
      for (const kept of keepPaths) {
        if (
          kept.startsWith(removed + path.sep) ||
          removed.startsWith(kept + path.sep)
        )
          blockedReason ||= "Retained and duplicate artifact paths overlap.";
      }
    }
    return { runId: entry.id, keepPaths, removePaths, blockedReason };
  });
  return {
    version: contentVersion(JSON.stringify({ runs, entries, issues })),
    needsReview: runs.length > 1 || duplicated || issues.length > 0,
    duplicated,
    entries,
    choices,
    issues,
  };
}

export function removeAnalysisArtifacts(
  roots: ArtifactRoots,
  runs: AnalysisRun[],
  version: string,
  keepRunId?: string,
  otherRuns: AnalysisRun[] = [],
): string[] {
  const inventory = analysisInventory(roots, runs);
  if (inventory.version !== version)
    throw new ArtifactError(
      "ANALYSIS_CHANGED",
      "Analysis data changed. Review the current files and confirm again.",
    );
  const choice = keepRunId
    ? inventory.choices.find((entry) => entry.runId === keepRunId)
    : null;
  if (keepRunId && (!choice || choice.blockedReason))
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      choice?.blockedReason || "Select an analysis to keep.",
    );
  if (!keepRunId && inventory.needsReview)
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      "Resolve the existing analysis records before rerunning.",
    );
  const targets = choice
    ? choice.removePaths
    : inventory.entries.flatMap((entry) => [
        ...(entry.output ? [entry.output.path] : []),
        ...entry.notes.map((note) => note.path),
      ]);
  const others = analysisInventory(roots, otherRuns);
  const sharedPaths = otherRuns.flatMap((run) =>
    run.runDir ? [path.resolve(run.runDir)] : [],
  );
  sharedPaths.push(
    ...others.entries.flatMap((entry) => entry.notes.map((note) => note.path)),
  );
  for (const target of targets) {
    if (
      sharedPaths.some(
        (other) =>
          target === other ||
          other.startsWith(target + path.sep) ||
          target.startsWith(other + path.sep),
      )
    )
      throw new ArtifactError(
        "SHARED_ARTIFACT",
        `Another analysis references this artifact: ${target}`,
      );
  }
  for (const target of targets)
    fs.rmSync(target, { recursive: true, force: true });
  return runs.filter((run) => run.id !== keepRunId).map((run) => run.id);
}

export function reportArtifactRoot(
  currentPath: string,
  reportUuid: string,
  kind: "analysis" | "digests",
): string {
  if (!/^[a-zA-Z0-9-]+$/.test(reportUuid))
    throw new Error("Invalid report identity.");
  const root = path.join(currentPath, "tmp", `${kind}-${reportUuid}`);
  assertOwnedPath(currentPath, root);
  return root;
}

export function traceIdentity(reportRoot: string, tracePath: string): string {
  const dataRoot = path.join(reportRoot, "data");
  assertOwnedPath(dataRoot, tracePath);
  const relative = path
    .relative(dataRoot, path.resolve(tracePath))
    .split(path.sep)
    .join("/")
    .replace(/\.zip$/i, "");
  return contentVersion(relative);
}

export function legacyDigestLocation(
  root: string,
  digest: { id: string; runDir: string; folder: string },
): string {
  const source = path.join(digest.runDir, digest.folder);
  assertOwnedPath(path.dirname(root), source);
  const destination = path.join(root, `legacy-${digest.id}`);
  assertOwnedPath(root, destination);
  if (fs.existsSync(source)) return source;
  if (fs.existsSync(destination)) return destination;
  throw new ArtifactError(
    "DIGEST_REVIEW_REQUIRED",
    `A saved digest is missing: ${source}`,
  );
}

export function moveLegacyDigest(
  root: string,
  digest: { id: string; runDir: string; folder: string },
  persist: (folder: string) => void,
): void {
  const source = legacyDigestLocation(root, digest);
  const destination = path.join(root, `legacy-${digest.id}`);
  if (source === destination) {
    persist(path.basename(destination));
    return;
  }
  if (fs.existsSync(destination))
    throw new ArtifactError(
      "DIGEST_REVIEW_REQUIRED",
      `Conflicting digest locations require review: ${source}, ${destination}`,
    );
  fs.renameSync(source, destination);
  try {
    persist(path.basename(destination));
  } catch (error) {
    fs.renameSync(destination, source);
    throw error;
  }
  try {
    fs.rmdirSync(digest.runDir);
  } catch {}
}

export function publishDigest(
  root: string,
  traceKey: string,
  source: string,
  persist: () => void,
): string {
  if (!/^[a-f0-9]{64}$/.test(traceKey))
    throw new Error("Invalid trace identity.");
  const target = path.join(root, traceKey);
  const backup = path.join(root, `.previous-${traceKey}`);
  assertOwnedPath(root, source);
  assertOwnedPath(root, target);
  assertOwnedPath(root, backup);
  if (fs.existsSync(backup)) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
    fs.renameSync(backup, target);
  }
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  let published = false;
  try {
    fs.renameSync(source, target);
    published = true;
    persist();
  } catch (error) {
    if (published) fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  return target;
}
