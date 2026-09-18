export {};

declare global {
  namespace TrendData {
    type Metric = "passed" | "total";
    type Status = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
    interface Report {
      uuid: string;
      name: string;
      metadata: string;
      createdAt: string;
      timestamp: string;
      timeSource: "report" | "attempt" | "catalog";
      scope: "current" | "archive";
      version: string;
      issue?: string;
    }
    interface Attempt {
      index: number;
      retry: number;
      startTime: string | null;
      duration: number;
      status: Status;
    }
    interface Observation {
      reportUuid: string;
      testId: string;
      path: string[];
      outcome: "expected" | "unexpected" | "flaky" | "skipped";
      attempts: Attempt[];
      passed: number | null;
      total: number | null;
    }
    interface Series {
      key: string;
      title: string;
      path: string[];
      file: string;
      project: string;
      repeat: number;
      ambiguous: boolean;
      observations: Observation[];
    }
    interface Dataset {
      schemaVersion: 1;
      generatedAt: string;
      reports: Report[];
      series: Series[];
    }
    interface Filters {
      query: string;
      rangeStart: string;
      rangeEnd: string;
    }
    interface CatalogReport {
      uuid: string;
      name: string;
      createdAt: string;
      metadata: string;
    }
    interface Catalog {
      current: CatalogReport[];
      archive: CatalogReport[];
    }
    interface Snapshot {
      schemaVersion: 1;
      exportedAt: string;
      filters: Filters;
      metric: Metric;
      data: Dataset;
    }
  }
}
