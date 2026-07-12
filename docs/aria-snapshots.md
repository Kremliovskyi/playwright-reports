# Aria Snapshot Fixer

[Back to documentation](index.md) | [Previous: Trace Digestion](trace-digestion.md)

The Aria Snapshot Fixer extracts failed `toMatchAriaSnapshot` comparisons from a Playwright HTML report and applies the reviewed result to the source snapshot file.

## Review and apply a fix

1. Click **Fix Snapshots** on a current report containing failed aria snapshot assertions.
2. Review the full-screen highlighted diff. Removed lines are the stored expectation; added lines are the structure captured by Playwright.
3. Enable the deep-equal option when the replacement should begin with `- /children: deep-equal`.
4. Click **Apply Fix**.
5. Rerun the affected Playwright test to verify the updated snapshot.

The dashboard reads the assertion call log and code frame embedded in the HTML report to reconstruct the evaluated structure and expected snapshot path. When a test contains multiple `.yml` assertions, it also uses content matching to select the intended snapshot. Missing snapshot directories are created when the fix is applied.

Always review the diff before applying it. Snapshot updates should represent an intentional accessibility-tree change rather than hide an application regression.
