import assert from "node:assert/strict";
import test from "node:test";

import { ManualResearchProvider } from "./provider";
import type { ResearchJobWorkItem } from "../supabase/syncService";

function buildJob(overrides: Partial<ResearchJobWorkItem> = {}): ResearchJobWorkItem {
  return {
    jobId: "test-job",
    lookupKey: "test-key",
    source: "manual",
    organizationId: "test-org",
    meetingId: "test-meeting",
    personId: "test-person",
    meetingTitle: "Test discovery call",
    startsAt: "2026-05-13T18:30:00.000Z",
    personFullName: "Jordan Patel",
    personEmail: "jordan.patel@northstar-bio.com",
    personTitle: "Head of Commercial Strategy",
    personLinkedInUrl: null,
    companyDomain: null,
    companyName: null,
    organizationName: "Listen",
    organizationDomain: "listen.dev",
    organizationLinkedInUrl: null,
    ...overrides,
  };
}

test("derives company context from business email and prepares LinkedIn search URLs", async () => {
  const provider = new ManualResearchProvider();

  const snapshot = await provider.enrich(buildJob());
  const rawPayload = snapshot.rawPayload as Record<string, unknown>;

  assert.equal(rawPayload.companyDomain, "northstar-bio.com");
  assert.equal(rawPayload.companyName, "Northstar Bio");
  assert.equal(rawPayload.domainSource, "email");
  assert.match(snapshot.personSummary ?? "", /northstar-bio\.com/i);
  assert.equal(snapshot.linkedInUrl, undefined);
  assert.ok(snapshot.references.some((value) => value === "https://northstar-bio.com"));
  assert.ok(snapshot.references.some((value) => value.includes("linkedin.com/search/results/all/")));
});

test("does not invent company context from personal email domains", async () => {
  const provider = new ManualResearchProvider();

  const snapshot = await provider.enrich(buildJob({
    personFullName: "Casey Morgan",
    personEmail: "casey.morgan@gmail.com",
    personTitle: "Independent Consultant",
  }));
  const rawPayload = snapshot.rawPayload as Record<string, unknown>;

  assert.equal(rawPayload.companyDomain, null);
  assert.equal(rawPayload.companyName, null);
  assert.equal(rawPayload.organizationDomain, "listen.dev");
  assert.equal(rawPayload.domainSource, "organization");
  assert.doesNotMatch(snapshot.personSummary ?? "", /gmail\.com suggests company context/i);
  assert.ok(snapshot.references.every((value) => value !== "https://gmail.com"));
  assert.ok(snapshot.references.some((value) => value.includes("linkedin.com/search/results/all/")));
});