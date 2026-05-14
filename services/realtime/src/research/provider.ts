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

interface DerivedResearchHints {
  companyName: string | null;
  companyDomain: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  companyWebsiteUrl: string | null;
  organizationWebsiteUrl: string | null;
  personLinkedInSearchUrl: string | null;
  organizationLinkedInSearchUrl: string | null;
  domainSource: "attendee" | "email" | "organization" | "none";
}

interface ResearchMergePolicy {
  allowInferredCompanyContext: boolean;
  bannedDomains: Set<string>;
}

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
]);

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

function normalizeDomain(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() || "";
  if (!trimmed) {
    return null;
  }

  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  const normalized = withoutProtocol.replace(/^www\./, "").replace(/\/.*/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

function extractDomainFromEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase() || "";
  const match = trimmed.match(/^[^@\s]+@([^@\s]+)$/);
  if (!match) {
    return null;
  }

  const domain = normalizeDomain(match[1]);
  if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain)) {
    return null;
  }

  return domain;
}

function readEmailDomain(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase() || "";
  const match = trimmed.match(/^[^@\s]+@([^@\s]+)$/);
  return match ? normalizeDomain(match[1]) : null;
}

function titleCaseWord(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function inferOrganizationNameFromDomain(domain: string | null): string | null {
  if (!domain) {
    return null;
  }

  const rootLabel = domain.split(".")[0] || "";
  if (!rootLabel) {
    return null;
  }

  const tokens = rootLabel.split(/[-_]+/).filter(Boolean);
  if (!tokens.length) {
    return null;
  }

  return tokens.map(titleCaseWord).join(" ");
}

function buildWebsiteUrl(domain: string | null): string | null {
  return domain ? `https://${domain}` : null;
}

function buildLinkedInSearchUrl(terms: Array<string | null | undefined>): string | null {
  const query = terms
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");

  if (!query) {
    return null;
  }

  return `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query)}`;
}

function deriveResearchHints(job: ResearchJobWorkItem): DerivedResearchHints {
  const companyName = normalizeUsefulOrganizationName(job.companyName);
  const organizationName = normalizeUsefulOrganizationName(job.organizationName);
  const attendeeDomain = normalizeDomain(job.companyDomain);
  const organizationDomain = normalizeDomain(job.organizationDomain);
  const emailDomain = extractDomainFromEmail(job.personEmail);
  const effectiveCompanyDomain = attendeeDomain ?? emailDomain;
  const effectiveOrganizationDomain = organizationDomain ?? effectiveCompanyDomain;
  const effectiveCompanyName = companyName ?? inferOrganizationNameFromDomain(effectiveCompanyDomain);
  const effectiveOrganizationName = organizationName ?? inferOrganizationNameFromDomain(effectiveOrganizationDomain);

  return {
    companyName: effectiveCompanyName,
    companyDomain: effectiveCompanyDomain,
    organizationName: effectiveOrganizationName,
    organizationDomain: effectiveOrganizationDomain,
    companyWebsiteUrl: buildWebsiteUrl(effectiveCompanyDomain),
    organizationWebsiteUrl: buildWebsiteUrl(effectiveOrganizationDomain),
    personLinkedInSearchUrl: buildLinkedInSearchUrl([
      job.personFullName,
      effectiveCompanyName,
      effectiveCompanyDomain,
    ]),
    organizationLinkedInSearchUrl: buildLinkedInSearchUrl([
      effectiveOrganizationName,
      effectiveOrganizationDomain,
    ]),
    domainSource: attendeeDomain ? "attendee" : emailDomain ? "email" : organizationDomain ? "organization" : "none",
  };
}

function buildResearchMergePolicy(job: ResearchJobWorkItem, fallback: ResearchSnapshot): ResearchMergePolicy {
  const fallbackPayload = (fallback.rawPayload ?? {}) as {
    companyDomain?: unknown;
    companyName?: unknown;
  };
  const emailDomain = readEmailDomain(job.personEmail);
  const bannedDomains = new Set<string>();

  if (emailDomain && PERSONAL_EMAIL_DOMAINS.has(emailDomain)) {
    bannedDomains.add(emailDomain);
  }

  const hasDeterministicCompanyContext = typeof fallbackPayload.companyDomain === "string" && fallbackPayload.companyDomain.trim()
    || typeof fallbackPayload.companyName === "string" && fallbackPayload.companyName.trim();

  return {
    allowInferredCompanyContext: Boolean(hasDeterministicCompanyContext),
    bannedDomains,
  };
}

function containsBannedDomain(value: string | undefined, policy: ResearchMergePolicy): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  for (const domain of policy.bannedDomains) {
    if (normalized.includes(domain)) {
      return true;
    }
  }

  return false;
}

function sanitizeSummary(value: string | undefined, fallbackValue: string | undefined, policy: ResearchMergePolicy): string | undefined {
  if (!value) {
    return fallbackValue;
  }

  if (!policy.allowInferredCompanyContext && containsBannedDomain(value, policy)) {
    return fallbackValue;
  }

  return value;
}

function sanitizeReferences(values: string[] | undefined, fallbackValues: string[], policy: ResearchMergePolicy): string[] {
  const candidateValues = values?.length ? values : fallbackValues;
  const sanitized = candidateValues.filter((value) => !containsBannedDomain(value, policy));
  return sanitized.length ? sanitized : fallbackValues.filter((value) => !containsBannedDomain(value, policy));
}

function sanitizeRecentSignals(values: string[] | undefined, fallbackValues: string[], policy: ResearchMergePolicy): string[] {
  const candidateValues = values?.length ? values : fallbackValues;
  const sanitized = candidateValues.filter((value) => !containsBannedDomain(value, policy));
  return sanitized.length ? sanitized : fallbackValues;
}

export class ManualResearchProvider implements ResearchProvider {
  async enrich(job: ResearchJobWorkItem): Promise<ResearchSnapshot> {
    const hints = deriveResearchHints(job);
    const sourceLinks: string[] = [];
    pushIfValue(sourceLinks, job.personLinkedInUrl);
    pushIfValue(sourceLinks, job.organizationLinkedInUrl);
    pushIfValue(sourceLinks, hints.companyWebsiteUrl);
    pushIfValue(sourceLinks, hints.organizationWebsiteUrl);
    if (!job.personLinkedInUrl) {
      pushIfValue(sourceLinks, hints.personLinkedInSearchUrl);
    }
    if (!job.organizationLinkedInUrl) {
      pushIfValue(sourceLinks, hints.organizationLinkedInSearchUrl);
    }

    const personSummaryParts: string[] = [];
    pushIfValue(personSummaryParts, job.personFullName);
    pushIfValue(personSummaryParts, job.personTitle ? `${job.personTitle} role detected.` : null);
    pushIfValue(personSummaryParts, job.personEmail ? `Reachable at ${job.personEmail}.` : null);
    pushIfValue(personSummaryParts, hints.companyName ? `Likely associated with ${hints.companyName}.` : null);
    pushIfValue(
      personSummaryParts,
      hints.companyDomain
        ? hints.domainSource === "email"
          ? `Work email domain suggests company context at ${hints.companyDomain}.`
          : `Observed company domain: ${hints.companyDomain}.`
        : null,
    );
    pushIfValue(personSummaryParts, !job.personLinkedInUrl && hints.personLinkedInSearchUrl ? "LinkedIn search link prepared for quick profile lookup." : null);

    const organizationSummaryParts: string[] = [];
    pushIfValue(organizationSummaryParts, hints.organizationName ? `${hints.organizationName} is the owning organization for this meeting.` : null);
    pushIfValue(organizationSummaryParts, hints.organizationDomain ? `Primary domain: ${hints.organizationDomain}.` : null);
    pushIfValue(organizationSummaryParts, hints.companyName && hints.companyName !== hints.organizationName ? `Guest company identified as ${hints.companyName}.` : null);
    pushIfValue(organizationSummaryParts, hints.companyWebsiteUrl ? `Review ${hints.companyWebsiteUrl} for current positioning and product context before the call.` : null);

    const recentSignals = [
      `Meeting booked: ${job.meetingTitle}`,
      `Scheduled start: ${new Date(job.startsAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
      job.personLinkedInUrl
        ? "A person LinkedIn URL is already attached for richer context."
        : hints.personLinkedInSearchUrl
          ? "Prepared a LinkedIn search link for quick person lookup."
          : "No LinkedIn profile URL or search hint could be prepared yet.",
      hints.companyDomain
        ? hints.domainSource === "email"
          ? `Derived likely company domain from work email: ${hints.companyDomain}.`
          : `Company domain available for context review: ${hints.companyDomain}.`
        : "No business domain could be inferred from attendee data.",
      hints.companyWebsiteUrl ? `Public website to review: ${hints.companyWebsiteUrl}.` : "No website URL could be assembled from the available data.",
      "This snapshot is seeded from attendee metadata plus deterministic email-domain inference.",
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
        companyName: hints.companyName,
        companyDomain: hints.companyDomain,
        organizationName: hints.organizationName,
        organizationDomain: hints.organizationDomain,
        companyWebsiteUrl: hints.companyWebsiteUrl,
        organizationWebsiteUrl: hints.organizationWebsiteUrl,
        personLinkedInSearchUrl: hints.personLinkedInSearchUrl,
        organizationLinkedInSearchUrl: hints.organizationLinkedInSearchUrl,
        domainSource: hints.domainSource,
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
    const fallback = await new ManualResearchProvider().enrich(job);
    const mergePolicy = buildResearchMergePolicy(job, fallback);
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
              "You create meeting research briefs. Respond with strict JSON only, with keys personSummary, organizationSummary, recentSignals, linkedInUrl, references. Keep summaries concise and avoid inventing facts. Use only the supplied meeting, attendee data, and deterministic hints. Infer context from business email domains when provided. If a direct LinkedIn profile is not known, keep linkedInUrl empty and put search URLs in references instead.",
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
              deterministicHints: fallback.rawPayload,
              fallbackSnapshot: {
                personSummary: fallback.personSummary,
                organizationSummary: fallback.organizationSummary,
                recentSignals: fallback.recentSignals,
                references: fallback.references,
              },
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

    return {
      personSummary: sanitizeSummary(parsed.personSummary, fallback.personSummary, mergePolicy),
      organizationSummary: sanitizeSummary(parsed.organizationSummary, fallback.organizationSummary, mergePolicy),
      recentSignals: sanitizeRecentSignals(parsed.recentSignals, fallback.recentSignals, mergePolicy),
      linkedInUrl: parsed.linkedInUrl || fallback.linkedInUrl,
      references: sanitizeReferences(parsed.references, fallback.references, mergePolicy),
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