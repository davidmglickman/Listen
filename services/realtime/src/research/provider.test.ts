import assert from "node:assert/strict";
import test from "node:test";

import { ManualResearchProvider, OpenAiResearchProvider } from "./provider";
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

test("rejects ai research that invents company context from personal email domains", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            personSummary: "Prospect: davidmglickman1@gmail.com Reachable at davidmglickman1@gmail.com. Likely associated with Gmail. Observed company domain: gmail.com.",
            organizationSummary: "Org: Verifaitrust is the owning organization for this meeting. Primary domain: verifaitrust.com. Guest company identified as Gmail. Review https://gmail.com for current positioning and product context before the call.",
            recentSignals: [
              "Meeting booked: test",
              "Observed company domain: gmail.com.",
            ],
            references: [
              "https://gmail.com",
              "https://www.linkedin.com/search/results/all/?keywords=davidmglickman1%20gmail.com",
            ],
          }),
        },
      },
    ],
  }), { status: 200 }) as Response;

  try {
    const provider = new OpenAiResearchProvider("test-key", "test-model", "https://example.com");
    const snapshot = await provider.enrich(buildJob({
      source: "manual",
      meetingTitle: "test",
      personFullName: "davidmglickman1@gmail.com",
      personEmail: "davidmglickman1@gmail.com",
      organizationName: "Verifaitrust",
      organizationDomain: "verifaitrust.com",
    }));

    assert.doesNotMatch(snapshot.personSummary ?? "", /Likely associated with Gmail|Observed company domain:\s*gmail\.com/i);
    assert.doesNotMatch(snapshot.organizationSummary ?? "", /Guest company identified as Gmail/i);
    assert.ok(snapshot.references.every((value) => value !== "https://gmail.com"));
    assert.ok(snapshot.references.some((value) => value.includes("linkedin.com/search/results/all/")));
    assert.ok(snapshot.recentSignals.every((value) => !/gmail\.com/i.test(value)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});