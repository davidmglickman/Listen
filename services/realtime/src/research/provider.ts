import type { ResearchSnapshot } from "@listen/shared";

import { getAiRuntimeConfig } from "../runtime/runtimeSecrets";
import type { ResearchJobWorkItem } from "../supabase/syncService";

export interface ResearchProvider {
  enrich(job: ResearchJobWorkItem): Promise<ResearchSnapshot>;
}

interface AiResearchResponse {
  personSummary?: string;
  organizationSummary?: string;
  recentSignals?: string[];
  linkedInUrl?: string;
  references?: string[];
}

function pushIfValue(items: string[], value: string | null | undefined): void {
  if (value && value.trim()) {
    items.push(value.trim());
  }
}

function normalizeUsefulOrganizationName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() || "";
  if (!trimmed) {
    return null;
  }

  if (/^[a-z]{12,}$/.test(trimmed) || /^[a-z0-9-]{16,}$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export class ManualResearchProvider implements ResearchProvider {
  async enrich(job: ResearchJobWorkItem): Promise<ResearchSnapshot> {
    const companyName = normalizeUsefulOrganizationName(job.companyName);
    const organizationName = normalizeUsefulOrganizationName(job.organizationName);
    const sourceLinks: string[] = [];
    pushIfValue(sourceLinks, job.personLinkedInUrl);
    pushIfValue(sourceLinks, job.organizationLinkedInUrl);

    const personSummaryParts: string[] = [];
    pushIfValue(personSummaryParts, job.personFullName);
    pushIfValue(personSummaryParts, job.personTitle ? `${job.personTitle} role detected.` : null);
    pushIfValue(personSummaryParts, job.personEmail ? `Reachable at ${job.personEmail}.` : null);
    pushIfValue(personSummaryParts, companyName ? `Associated with ${companyName}.` : null);
    pushIfValue(personSummaryParts, job.companyDomain ? `Observed company domain: ${job.companyDomain}.` : null);

    const organizationSummaryParts: string[] = [];
    pushIfValue(organizationSummaryParts, organizationName ? `${organizationName} is the owning organization for this meeting.` : null);
    pushIfValue(organizationSummaryParts, job.organizationDomain ? `Primary domain: ${job.organizationDomain}.` : null);
    pushIfValue(organizationSummaryParts, companyName && companyName !== organizationName ? `Guest company identified as ${companyName}.` : null);

    const recentSignals = [
      `Meeting booked: ${job.meetingTitle}`,
      `Scheduled start: ${new Date(job.startsAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
      job.personLinkedInUrl ? "A person LinkedIn URL is already attached for richer context." : "No LinkedIn profile URL attached yet.",
      job.companyDomain ? `Company domain observed from attendee data: ${job.companyDomain}.` : "No company domain detected from attendee data.",
      "This snapshot is seeded from calendar and attendee metadata. Replace it with an enrichment provider for deeper research.",
    ];

    return {
      personSummary: personSummaryParts.join(" ") || undefined,
      organizationSummary: organizationSummaryParts.join(" ") || undefined,
      recentSignals,
      linkedInUrl: job.personLinkedInUrl ?? undefined,
      references: sourceLinks,
      rawPayload: {
        provider: "manual",
        lookupKey: job.lookupKey,
        meetingTitle: job.meetingTitle,
        personFullName: job.personFullName,
        personEmail: job.personEmail,
        personTitle: job.personTitle,
        companyName,
        companyDomain: job.companyDomain,
        organizationName,
        organizationDomain: job.organizationDomain,
      },
    };
  }
}

function getAiConfig(): { apiKey: string | null; model: string; baseUrl: string } {
  return getAiRuntimeConfig();
}

function normalizeUrlArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value));
}

function parseAiResearchResponse(content: string): AiResearchResponse {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    personSummary: typeof parsed.personSummary === "string" ? parsed.personSummary.trim() : undefined,
    organizationSummary: typeof parsed.organizationSummary === "string" ? parsed.organizationSummary.trim() : undefined,
    recentSignals: Array.isArray(parsed.recentSignals)
      ? parsed.recentSignals.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
      : undefined,
    linkedInUrl: typeof parsed.linkedInUrl === "string" && /^https?:\/\//i.test(parsed.linkedInUrl) ? parsed.linkedInUrl.trim() : undefined,
    references: normalizeUrlArray(parsed.references),
  };
}

export class OpenAiResearchProvider implements ResearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async enrich(job: ResearchJobWorkItem): Promise<ResearchSnapshot> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You create meeting research briefs. Respond with strict JSON only, with keys personSummary, organizationSummary, recentSignals, linkedInUrl, references. Keep summaries concise and avoid inventing facts. Use only the supplied meeting and attendee data.",
          },
          {
            role: "user",
            content: JSON.stringify({
              meetingTitle: job.meetingTitle,
              startsAt: job.startsAt,
              personFullName: job.personFullName,
              personEmail: job.personEmail,
              personTitle: job.personTitle,
              personLinkedInUrl: job.personLinkedInUrl,
              companyName: job.companyName,
              companyDomain: job.companyDomain,
              organizationName: job.organizationName,
              organizationDomain: job.organizationDomain,
              organizationLinkedInUrl: job.organizationLinkedInUrl,
              source: job.source,
            }),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "meeting_research_brief",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                personSummary: { type: "string" },
                organizationSummary: { type: "string" },
                recentSignals: {
                  type: "array",
                  items: { type: "string" },
                },
                linkedInUrl: { type: "string" },
                references: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["recentSignals", "references"],
            },
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`AI research request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };

    const rawContent = payload.choices?.[0]?.message?.content;
    const content = Array.isArray(rawContent)
      ? rawContent.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
      : rawContent;

    if (!content || typeof content !== "string") {
      throw new Error("AI research response did not include content.");
    }

    const parsed = parseAiResearchResponse(content);
    const fallback = await new ManualResearchProvider().enrich(job);

    return {
      personSummary: parsed.personSummary || fallback.personSummary,
      organizationSummary: parsed.organizationSummary || fallback.organizationSummary,
      recentSignals: parsed.recentSignals?.length ? parsed.recentSignals : fallback.recentSignals,
      linkedInUrl: parsed.linkedInUrl || fallback.linkedInUrl,
      references: parsed.references?.length ? parsed.references : fallback.references,
      rawPayload: {
        provider: "openai",
        model: this.model,
        lookupKey: job.lookupKey,
        aiResponse: parsed,
        fallback: fallback.rawPayload,
      },
    };
  }
}

export function createResearchProvider(providerName: string): ResearchProvider {
  const aiConfig = getAiConfig();

  switch (providerName) {
    case "openai":
      if (!aiConfig.apiKey) {
        console.warn("SUPABASE_RESEARCH_PROVIDER=openai was set, but no AI API key was configured. Falling back to manual research provider.");
        return new ManualResearchProvider();
      }

      return new OpenAiResearchProvider(aiConfig.apiKey, aiConfig.model, aiConfig.baseUrl);
    case "manual":
    default:
      return new ManualResearchProvider();
  }
}