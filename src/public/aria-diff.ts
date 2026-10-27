namespace AriaDiff {
  // Simple Diffing Logic
  export interface DiffLine {
    type: "added" | "removed" | "unchanged";
    text: string;
  }

  export function normalizeIndent(str: string): string {
    const normalized = str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const indents = lines
      .filter((l) => l.length > 0 && l.trimStart().length < l.length)
      .map((l) => l.length - l.trimStart().length);
    const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
    if (minIndent === 0 || minIndent === 2) return normalized;
    return lines
      .map((l) => {
        if (l.length === 0) return l;
        const spaces = l.length - l.trimStart().length;
        const level = Math.floor(spaces / minIndent);
        return " ".repeat(level * 2) + l.trimStart();
      })
      .join("\n");
  }

  export function computeDiff(oldStr: string, newStr: string): DiffLine[] {
    const oldLines = oldStr
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    const newLines = newStr
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");

    const prefix = "- /children: deep-equal";
    const cleanOldLines = oldLines[0] === prefix ? oldLines.slice(1) : oldLines;
    const cleanNewLines = newLines[0] === prefix ? newLines.slice(1) : newLines;

    // A basic Longest Common Subsequence (LCS) algorithm for diffing
    const m = cleanOldLines.length;
    const n = cleanNewLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0),
    );

    for (let i = 1;i <= m;i++) {
      for (let j = 1;j <= n;j++) {
        if (cleanOldLines[i - 1] === cleanNewLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const diff: DiffLine[] = [];
    let i = m,
      j = n;
    while (i > 0 && j > 0) {
      if (cleanOldLines[i - 1] === cleanNewLines[j - 1]) {
        diff.unshift({ type: "unchanged", text: cleanOldLines[i - 1] });
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        diff.unshift({ type: "removed", text: cleanOldLines[i - 1] });
        i--;
      } else {
        diff.unshift({ type: "added", text: cleanNewLines[j - 1] });
        j--;
      }
    }
    while (i > 0) {
      diff.unshift({ type: "removed", text: cleanOldLines[i - 1] });
      i--;
    }
    while (j > 0) {
      diff.unshift({ type: "added", text: cleanNewLines[j - 1] });
      j--;
    }

    return diff;
  }

}
