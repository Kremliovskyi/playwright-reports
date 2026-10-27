namespace DashboardModel {
  export interface Report {
    id: string;
    uuid: string;
    path: string;
    name: string;
    createdAt: string;
    metadata: string;
  }

  export interface ReportsResponse {
    current: Report[];
    archive: Report[];
    configStatus: {
      hasCurrent: boolean;
      hasArchive: boolean;
      hasProject?: boolean;
    };
    warnings?: { code: string; path: string; message: string }[];
  }

  export interface ReportTarget {
    reportPath: string;
    reportUuid: string;
  }

  export class ReportTargets {
    private readonly reports = new Map<string, string>();

    remember(report: Report): void {
      this.reports.set(report.path, report.uuid);
    }

    get(reportPath: string): ReportTarget {
      const reportUuid = this.reports.get(reportPath);
      if (!reportUuid) throw new Error("Report identity is unavailable. Refresh before trying again.");
      return { reportPath, reportUuid };
    }
  }

  export interface SearchFilters {
    query: string;
    rangeStart: string;
    rangeEnd: string;
  }

  export interface SearchState {
    isOpen: boolean;
    draft: SearchFilters;
    applied: SearchFilters | null;
  }

  export const createEmptySearchFilters = (): SearchFilters => ({
    query: "",
    rangeStart: "",
    rangeEnd: "",
  });

  export const normalizeSearchFilters = (filters: SearchFilters): SearchFilters => ({
    query: filters.query.trim(),
    rangeStart: filters.rangeStart,
    rangeEnd: filters.rangeEnd,
  });

  export const hasSearchFilters = (filters: SearchFilters) => {
    return Boolean(filters.query || filters.rangeStart || filters.rangeEnd);
  };

  export const buildSearchUrl = (filters: SearchFilters) => {
    const params = new URLSearchParams();
    if (filters.query) params.set("query", filters.query);
    if (filters.rangeStart) params.set("rangeStart", filters.rangeStart);
    if (filters.rangeEnd) params.set("rangeEnd", filters.rangeEnd);
    const queryString = params.toString();
    return queryString
      ? `/api/report-search?${queryString}`
      : "/api/report-search";
  };

}
