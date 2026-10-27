import { Request, Response } from "express";
import {
  AppConfig,
  getConfig
} from "./db";

// Global AppConfig cache for fast synchronous access in middlewares
export let appConfig: AppConfig = getConfig();

// Cache of computed report-folder sizes (recursive disk scans are expensive). The report folder is a
// sibling of the ephemeral output dirs (currentPath/tmp/...), so deleting analysis runs never changes
// it — the cache only needs clearing when the report folder itself is mutated (extract/archive/rename/delete).
export const reportSizeCache = new Map<string, number>();

export const invalidateReportSize = (reportId: string): void => {
  reportSizeCache.delete(reportId);
};

export const activeFailureAnalyses = new Set<string>();

export const activeDigests = new Set<string>();

export const activeExtractions = new Set<string>();

export const reportIsBusy = (uuid: string): boolean =>
  activeExtractions.has(uuid) ||
  activeFailureAnalyses.has(uuid) ||
  [...activeDigests].some((key) => key.startsWith(uuid + ":"));

export const refreshConfigCache = () => {
  appConfig = getConfig();
};

const sseClients = new Set<Response>();

export const subscribeLogs = (req: Request, res: Response): void => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
};

export const broadcastLog = (type: string, data: string) => {
  sseClients.forEach((client) => {
    client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  });
};

// Broadcast a structured JSON payload (single JSON.parse on the client side).
export const broadcastJson = (type: string, payload: unknown) => {
  sseClients.forEach((client) => {
    client.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  });
};
