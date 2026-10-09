#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { parseArgs } from "node:util";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      format: { type: "string", short: "f", default: "json" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  if (values.help) {
    console.log(
      "Usage: playwright-reports init-skills [targetDir] [--format json|text] [--force]"
    );
    return;
  }
  if (positionals[0] !== "init-skills" || positionals.length > 2)
    throw new Error("Expected: playwright-reports init-skills [targetDir]");
  if (values.format !== "json" && values.format !== "text")
    throw new Error('Invalid format. Expected "json" or "text".');
  const target = path.resolve(positionals[1] ?? process.cwd());
  const templates = path.resolve(__dirname, "../templates/skills");
  const skills: { name: string; skillPath: string; status: string }[] = [];
  for (const name of (await fs.readdir(templates)).sort()) {
    const source = path.join(templates, name, "SKILL.md");
    const skillPath = path.join(target, ".github/skills", name, "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    let status = "installed";
    try {
      await fs.copyFile(
        source,
        skillPath,
        values.force ? 0 : constants.COPYFILE_EXCL
      );
    } catch (error) {
      if (!values.force && (error as NodeJS.ErrnoException).code === "EEXIST")
        status = "skipped";
      else throw error;
    }
    skills.push({ name, skillPath, status });
  }
  console.log(
    values.format === "json"
      ? JSON.stringify(
          { schemaVersion: 1, command: "init-skills", skills },
          null,
          2
        )
      : skills.map((skill) => `${skill.status}: ${skill.skillPath}`).join("\n")
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
