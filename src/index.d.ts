export interface SnapshotProgress {
  type: 'captured' | 'failed';
  url: string;
  output?: string;
  kind?: string;
  status?: number;
  bytes?: number;
  reason?: string;
  message?: string;
}

export interface SnapshotOptions {
  url: string | URL;
  outputDir?: string;
  clean?: boolean;
  forceClean?: boolean;
  concurrency?: number;
  maxPages?: number;
  maxAssets?: number;
  maxQueryVariants?: number;
  maxResourceBytes?: number;
  maxTotalBytes?: number;
  timeout?: number;
  maxRedirects?: number;
  robots?: boolean;
  sitemap?: boolean;
  capture404?: boolean;
  skipWordPressCheck?: boolean;
  externalAssets?: boolean;
  allowPrivateNetwork?: boolean;
  strict?: boolean;
  report?: boolean;
  publicUrl?: string | URL | null;
  headers?: Record<string, string> | Iterable<readonly [string, string]>;
  signal?: AbortSignal;
  onProgress?: (progress: SnapshotProgress) => void;
}

export interface SnapshotResource {
  url: string;
  output: string;
  kind: string;
  contentType: string;
  status: number;
  bytes: number;
}

export interface SnapshotIssue {
  url?: string | null;
  reason?: string;
  message?: string;
  referrer?: string | null;
}

export interface SnapshotResult {
  outputDir: string;
  sourceUrl: string;
  pages: number;
  assets: number;
  redirects: number;
  bytes: number;
  skipped: SnapshotIssue[];
  failures: SnapshotIssue[];
  warnings: SnapshotIssue[];
  liveDependencies: string[];
  resources: SnapshotResource[];
  reportPath: string | null;
}

export declare class SnapshotError extends Error {
  code: string;
  constructor(message: string, code?: string, cause?: unknown);
}

export declare function snapshot(options: SnapshotOptions): Promise<SnapshotResult>;
