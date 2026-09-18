const AdmZip = require("adm-zip");

function trendTest(overrides = {}) {
  return {
    testId: "test-id",
    title: "e2eExampleTC01 - completes the order",
    projectName: "all-falcons",
    location: { file: "tests/order.spec.ts", line: 10, column: 1 },
    path: ["Orders [DEV NA - 6/1]"],
    outcome: "expected",
    duration: 120000,
    results: [
      {
        retry: 0,
        startTime: "2026-06-01T07:00:00.000Z",
        duration: 120000,
        status: "passed",
      },
    ],
    ...overrides,
  };
}

function reportHtml(tests = [trendTest()], options = {}) {
  const zip = new AdmZip();
  zip.addFile(
    "report.json",
    Buffer.from(
      JSON.stringify({
        startTime:
          options.startTime === undefined
            ? Date.parse("2026-06-01T07:00:00.000Z")
            : options.startTime,
        files: [
          {
            fileId: "spec",
            fileName: "order.spec.ts",
            tests: tests.map(({ results, ...test }) => ({
              ...test,
              results: results.map(({ startTime }) => ({
                startTime,
                attachments: [],
              })),
            })),
          },
        ],
      }),
    ),
  );
  zip.addFile("spec.json", Buffer.from(JSON.stringify({ tests })));
  const encoded = zip.toBuffer().toString("base64");
  const payload =
    options.style === "window"
      ? `<script>window.playwrightReportBase64 = "${encoded}";</script>`
      : `<${options.style || "template"} id="playwrightReportBase64">data:application/zip;base64,${encoded}</${options.style || "template"}>`;
  return `<!doctype html><title>Playwright Test Report</title><h1>Synthetic Playwright report</h1>${payload}`;
}

module.exports = { trendTest, reportHtml };
