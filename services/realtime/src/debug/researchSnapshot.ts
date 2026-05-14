import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ResearchJobWorkItem } from "../supabase/syncService";
import { ManualResearchProvider } from "../research/provider";

type DebugResearchInput = Partial<ResearchJobWorkItem>;

const DEFAULT_RESEARCH_JOB: ResearchJobWorkItem = {
  jobId: "debug-job",
  lookupKey: "sam-taylor:acme-health.com",
  source: "manual",
  organizationId: "debug-org",
  meetingId: "debug-meeting",
  personId: "debug-person",
  meetingTitle: "Discovery Call with Acme Health",
  startsAt: "2026-05-13T16:00:00.000Z",
  personFullName: "Sam Taylor",
  personEmail: "sam.taylor@acme-health.com",
  personTitle: "VP of Revenue Operations",
  personLinkedInUrl: null,
  companyDomain: null,
  companyName: null,
  organizationName: "Listen",
  organizationDomain: "listen.dev",
  organizationLinkedInUrl: null,
};

async function loadDebugInput(filePath: string | undefined): Promise<ResearchJobWorkItem> {
  if (!filePath) {
    return DEFAULT_RESEARCH_JOB;
  }

  const absolutePath = path.resolve(process.cwd(), filePath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as DebugResearchInput;

  return {
    ...DEFAULT_RESEARCH_JOB,
    ...parsed,
  };
}

async function main(): Promise<void> {
  const input = await loadDebugInput(process.argv[2]);
  const provider = new ManualResearchProvider();
  const snapshot = await provider.enrich(input);

  console.log(JSON.stringify({
    input,
    snapshot,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});