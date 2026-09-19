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
      id: string;
      definition: string;
      reportUuid: string;
      testId: string;
      title: string;
      file: string;
      line: number | null;
      column: number | null;
      project: string;
      repeat: number | null;
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
      schemaVersion: 2;
      generatedAt: string;
      reports: Report[];
      series: Series[];
      selection?: { excludedReports: number; excludedExecutions: number };
    }
    interface Preview {
      schemaVersion: 2;
      generatedAt: string;
      testQuery: string;
      reports: Report[];
      candidates: Observation[];
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
      schemaVersion: 2;
      exportedAt: string;
      filters: Filters;
      metric: Metric;
      data: Dataset;
    }
  }
}
