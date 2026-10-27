import AdmZip from "adm-zip";

export function readReportArchive(html: string): AdmZip {
  const encoded =
    html.match(/window\.playwrightReportBase64\s*=\s*["']([^"']+)["']/)?.[1] ??
    html.match(
      /<(?:script|template)\b[^>]*\bid=["']playwrightReportBase64["'][^>]*>([^<]+)<\/(?:script|template)>/
    )?.[1];
  if (!encoded)
    throw new Error("Unsupported report: embedded report data is missing.");
  return new AdmZip(
    Buffer.from(
      encoded.trim().replace(/^data:application\/zip;base64,/, ""),
      "base64"
    )
  );
}
