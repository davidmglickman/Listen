import type { ResearchProvider } from "./provider";

import type { SupabaseSyncService } from "../supabase/syncService";

export class ResearchWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly syncService: SupabaseSyncService,
    private readonly provider: ResearchProvider,
    private readonly pollMs: number,
  ) {}

  start(): void {
    if (!this.syncService.isConfigured() || this.intervalId) {
      return;
    }

    this.intervalId = setInterval(() => {
      void this.runWithLogging();
    }, this.pollMs);
    void this.runWithLogging();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async runOnce(): Promise<{ processedCount: number }> {
    if (this.isRunning || !this.syncService.isConfigured()) {
      return { processedCount: 0 };
    }

    this.isRunning = true;
    try {
      const jobs = await this.syncService.claimQueuedResearchJobs(10);
      for (const job of jobs) {
        try {
          const snapshot = await this.provider.enrich(job);
          await this.syncService.markResearchJobCompleted(job.jobId, snapshot);
        } catch (error) {
          await this.syncService.completeResearchJob(job.jobId, {
            status: "failed",
            error: error instanceof Error ? error.message : "Research provider failed.",
          });
        }
      }

      return { processedCount: jobs.length };
    } finally {
      this.isRunning = false;
    }
  }

  private async runWithLogging(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      console.error("Research worker run failed", error);
    }
  }
}