import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { assertOwnedPath, type ArtifactRoots } from "./report-artifacts";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});
const relativeLink = (value: string) =>
  !/^(?:[a-z][a-z\d+.-]*:|[/#])/i.test(value);
for (const [rule, attribute] of [
  ["link_open", "href"],
  ["image", "src"],
]) {
  const original = markdown.renderer.rules[rule];
  markdown.renderer.rules[rule] = (
    tokens,
    index,
    options,
    env: { sourceUrl?: string },
    renderer,
  ) => {
    const value = tokens[index].attrGet(attribute);
    if (value && env.sourceUrl && relativeLink(value)) {
      const url = new URL(value, "http://localhost" + env.sourceUrl);
      tokens[index].attrSet(attribute, url.pathname + url.search + url.hash);
    }
    return original
      ? original(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
  };
}

export function analysisSourceUrl(
  roots: ArtifactRoots,
  file: string,
): string | undefined {
  for (const [scope, root] of [
    ["current", roots.currentPath],
    ["archive", roots.archivePath],
  ]) {
    if (!root) continue;
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      continue;
    assertOwnedPath(root, file);
    return `/reports/${scope}/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
  }
  return undefined;
}

export function renderAnalysisMarkdown(
  content: string,
  sourceUrl?: string,
): string {
  return markdown.render(content, { sourceUrl });
}

export function analysisLinkWarnings(root: string, content: string): string[] {
  const warnings = new Set<string>();
  let truncated = false;
  const warn = (message: string) => {
    if (warnings.size < 40) warnings.add(message);
    else truncated = true;
  };
  const visit = (tokens: ReturnType<typeof markdown.parse>) => {
    for (const token of tokens) {
      const value = token.attrGet(token.type === "image" ? "src" : "href");
      if (value && !value.startsWith("#") && !/^https?:/i.test(value)) {
        if (!relativeLink(value))
          warn(`Producer/absolute link was not relocated or checked: ${value}`);
        else {
          try {
            const file = path.resolve(
              root,
              decodeURIComponent(value.split(/[?#]/)[0]),
            );
            assertOwnedPath(root, file);
            if (!fs.existsSync(file))
              warn(`Missing bundle-relative link: ${value}`);
          } catch (error) {
            warn(
              `Unresolved bundle-relative link: ${value} (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }
      }
      if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(content, {}));
  return [
    ...warnings,
    ...(truncated
      ? ["Additional link warnings omitted. Review the original Markdown."]
      : []),
  ];
}
