import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CalendarSyncRequest,
  CompleteResearchJobRequest,
  MeetingAttendee,
  MeetingResearchBrief,
  ProspectOrganization,
  ResearchSnapshot,
} from "@listen/shared";

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

interface OrganizationRow {
  id: string;
}

interface MeetingRow {
  id: string;
}

interface PersonRow {
  id: string;
}

interface ResearchJobRow {
  id: string;
  status?: string;
}

interface MeetingResearchRow {
  external_id: string | null;
  updated_at: string;
  research_jobs: Array<{
    status: string;
    research_snapshots: {
      person_summary: string | null;
      organization_summary: string | null;
      recent_signals: string[] | null;
      linkedin_url: string | null;
      source_links: string[] | null;
      updated_at: string;
    } | null;
  }> | null;
}

export interface ResearchJobWorkItem {
  jobId: string;
  lookupKey: string;
  source: string;
  organizationId: string;
  meetingId: string;
  personId: string | null;
  meetingTitle: string;
  startsAt: string;
  personFullName: string | null;
  personEmail: string | null;
  personTitle: string | null;
  personLinkedInUrl: string | null;
  companyDomain: string | null;
  companyName: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  organizationLinkedInUrl: string | null;
}

export class SupabaseSyncService {
  constructor(
    private readonly client: SupabaseClient | null,
    private readonly defaultOrganizationSlug: string,
  ) {}

  isConfigured(): boolean {
    return this.client !== null;
  }

  async syncCalendarMeeting(payload: CalendarSyncRequest): Promise<{ meetingId: string; queuedResearchJobIds: string[] }> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const organizationId = await this.upsertOrganization(
      payload.organization ?? {
        name: this.defaultOrganizationSlug,
      },
    );
    const meetingId = await this.upsertMeeting(organizationId, payload);

    await this.client.from("meeting_attendees").delete().eq("meeting_id", meetingId);

    const queuedResearchJobIds: string[] = [];
    for (const attendee of payload.attendees) {
      const personId = await this.upsertPerson(organizationId, attendee);
      await this.client.from("meeting_attendees").insert({
        meeting_id: meetingId,
        person_id: personId,
        full_name: attendee.fullName,
        email: attendee.email ?? null,
        title: attendee.title ?? null,
        linkedin_url: attendee.linkedInUrl ?? null,
        role: attendee.role,
      });

      if (attendee.role === "guest") {
        const jobId = await this.createResearchJob(organizationId, meetingId, personId, attendee);
        queuedResearchJobIds.push(jobId);
      }
    }

    return { meetingId, queuedResearchJobIds };
  }

  async completeResearchJob(jobId: string, payload: CompleteResearchJobRequest): Promise<void> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { data: existingJob, error: jobError } = await this.client
      .from("research_jobs")
      .select("id, organization_id")
      .eq("id", jobId)
      .single<ResearchJobRow & { organization_id: string }>();

    if (jobError || !existingJob) {
      throw new Error(jobError?.message ?? "Research job not found.");
    }

    const { error: updateError } = await this.client
      .from("research_jobs")
      .update({
        status: payload.status,
        error: payload.error ?? null,
      })
      .eq("id", jobId);
    if (updateError) {
      throw new Error(updateError.message);
    }

    if (payload.snapshot) {
      const { error: snapshotError } = await this.client.from("research_snapshots").upsert(
        {
          research_job_id: jobId,
          organization_id: existingJob.organization_id,
          person_summary: payload.snapshot.personSummary ?? null,
          organization_summary: payload.snapshot.organizationSummary ?? null,
          recent_signals: payload.snapshot.recentSignals,
          linkedin_url: payload.snapshot.linkedInUrl ?? null,
          source_links: payload.snapshot.references,
          raw_payload: payload.snapshot.rawPayload as Json,
        },
        { onConflict: "research_job_id" },
      );
      if (snapshotError) {
        throw new Error(snapshotError.message);
      }
    }
  }

  async claimQueuedResearchJobs(limit: number): Promise<ResearchJobWorkItem[]> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { data: queuedJobs, error } = await this.client
      .from("research_jobs")
      .select(
        `
          id,
          lookup_key,
          source,
          organization_id,
          meeting_id,
          person_id,
          meetings!inner(id, title, starts_at),
          people(id, full_name, email, title, linkedin_url, company_domain, company_name),
          organizations!research_jobs_organization_id_fkey(id, name, domain, linkedin_url)
        `,
      )
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(error.message);
    }

    const claimed: ResearchJobWorkItem[] = [];
    for (const job of (queuedJobs ?? []) as Array<Record<string, unknown>>) {
      const jobId = String(job.id);
      const { error: updateError } = await this.client
        .from("research_jobs")
        .update({ status: "running", error: null })
        .eq("id", jobId)
        .eq("status", "queued");

      if (updateError) {
        throw new Error(updateError.message);
      }

      const meeting = job.meetings as { id: string; title: string; starts_at: string } | null;
      const person = job.people as {
        id: string;
        full_name: string | null;
        email: string | null;
        title: string | null;
        linkedin_url: string | null;
        company_domain: string | null;
        company_name: string | null;
      } | null;
      const organization = job.organizations as {
        id: string;
        name: string | null;
        domain: string | null;
        linkedin_url: string | null;
      } | null;

      if (!meeting) {
        await this.completeResearchJob(jobId, {
          status: "failed",
          error: "Meeting data missing for queued research job.",
        });
        continue;
      }

      claimed.push({
        jobId,
        lookupKey: String(job.lookup_key ?? ""),
        source: String(job.source ?? "manual"),
        organizationId: String(job.organization_id),
        meetingId: String(job.meeting_id),
        personId: person?.id ?? null,
        meetingTitle: meeting.title,
        startsAt: meeting.starts_at,
        personFullName: person?.full_name ?? null,
        personEmail: person?.email ?? null,
        personTitle: person?.title ?? null,
        personLinkedInUrl: person?.linkedin_url ?? null,
        companyDomain: person?.company_domain ?? null,
        companyName: person?.company_name ?? null,
        organizationName: organization?.name ?? null,
        organizationDomain: organization?.domain ?? null,
        organizationLinkedInUrl: organization?.linkedin_url ?? null,
      });
    }

    return claimed;
  }

  async markResearchJobCompleted(jobId: string, snapshot: ResearchSnapshot): Promise<void> {
    await this.completeResearchJob(jobId, {
      status: "completed",
      snapshot,
    });
  }

  async listMeetingResearch(limit: number): Promise<MeetingResearchBrief[]> {
    if (!this.client) {
      return [];
    }

    const { data, error } = await this.client
      .from("meetings")
      .select(
        `
          external_id,
          updated_at,
          research_jobs(
            status,
            research_snapshots(
              person_summary,
              organization_summary,
              recent_signals,
              linkedin_url,
              source_links,
              updated_at
            )
          )
        `,
      )
      .order("starts_at", { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(error.message);
    }

    const meetings = ((data ?? []) as unknown as MeetingResearchRow[])
      .map((meeting): MeetingResearchBrief | null => {
        if (!meeting.external_id) {
          return null;
        }

        const researchJob = (meeting.research_jobs ?? [])[0];
        const snapshot = researchJob?.research_snapshots ?? null;
        return {
          meetingExternalId: meeting.external_id,
          status: (researchJob?.status ?? "queued") as MeetingResearchBrief["status"],
          personSummary: snapshot?.person_summary ?? undefined,
          organizationSummary: snapshot?.organization_summary ?? undefined,
          recentSignals: snapshot?.recent_signals ?? [],
          linkedInUrl: snapshot?.linkedin_url ?? undefined,
          sourceLinks: snapshot?.source_links ?? [],
          updatedAt: snapshot?.updated_at ?? meeting.updated_at,
        } satisfies MeetingResearchBrief;
      });

    return meetings.filter((value): value is MeetingResearchBrief => value !== null);
  }

  private async upsertOrganization(organization: ProspectOrganization): Promise<string> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const slug = this.slugify(organization.domain || organization.name || this.defaultOrganizationSlug);
    const { data, error } = await this.client
      .from("organizations")
      .upsert(
        {
          slug,
          name: organization.name,
          domain: organization.domain ?? null,
          linkedin_url: organization.linkedInUrl ?? null,
          description: organization.description ?? null,
          industry: organization.industry ?? null,
        },
        { onConflict: "slug" },
      )
      .select("id")
      .single<OrganizationRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to upsert organization.");
    }

    return data.id;
  }

  private async upsertMeeting(organizationId: string, payload: CalendarSyncRequest): Promise<string> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const externalId = payload.meeting.externalId ?? `${payload.meeting.title}:${payload.meeting.startsAt}`;
    const { data, error } = await this.client
      .from("meetings")
      .upsert(
        {
          organization_id: organizationId,
          owner_user_id: payload.userId ?? null,
          external_id: externalId,
          title: payload.meeting.title,
          starts_at: payload.meeting.startsAt,
          ends_at: payload.meeting.endsAt,
          source: payload.meeting.source,
          organizer_email: payload.meeting.organizerEmail ?? null,
          join_url: payload.meeting.joinUrl ?? null,
          notes: payload.meeting.notes ?? null,
          context: (payload.meeting.context ?? null) as Json,
        },
        { onConflict: "organization_id,external_id" },
      )
      .select("id")
      .single<MeetingRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to upsert meeting.");
    }

    return data.id;
  }

  private async upsertPerson(organizationId: string, attendee: MeetingAttendee): Promise<string | null> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    if (attendee.email) {
      const { data: existingByEmail } = await this.client
        .from("people")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("email", attendee.email)
        .maybeSingle<PersonRow>();
      if (existingByEmail) {
        return existingByEmail.id;
      }
    }

    const { data, error } = await this.client
      .from("people")
      .insert({
        organization_id: organizationId,
        full_name: attendee.fullName,
        email: attendee.email ?? null,
        title: attendee.title ?? null,
        linkedin_url: attendee.linkedInUrl ?? null,
        company_domain: attendee.organizationDomain ?? null,
        company_name: attendee.organizationName ?? null,
      })
      .select("id")
      .single<PersonRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to upsert person.");
    }

    return data.id;
  }

  private async createResearchJob(
    organizationId: string,
    meetingId: string,
    personId: string | null,
    attendee: MeetingAttendee,
  ): Promise<string> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const lookupKey = attendee.linkedInUrl ?? attendee.email ?? `${attendee.fullName}:${attendee.organizationDomain ?? attendee.organizationName ?? "unknown"}`;
    let existingQuery = this.client
      .from("research_jobs")
      .select("id, status")
      .eq("meeting_id", meetingId)
      .eq("lookup_key", lookupKey)
      .in("status", ["queued", "running", "completed"])
      .order("created_at", { ascending: false })
      .limit(1);

    if (personId) {
      existingQuery = existingQuery.eq("person_id", personId);
    }

    const { data: existingJobs, error: existingError } = await existingQuery;
    if (existingError) {
      throw new Error(existingError.message);
    }

    const existingJob = (existingJobs ?? [])[0] as ResearchJobRow | undefined;
    if (existingJob?.id) {
      return existingJob.id;
    }

    const { data, error } = await this.client
      .from("research_jobs")
      .insert({
        organization_id: organizationId,
        meeting_id: meetingId,
        person_id: personId,
        status: "queued",
        source: attendee.linkedInUrl ? "linkedin_url" : attendee.organizationDomain ? "company_domain" : "manual",
        lookup_key: lookupKey,
      })
      .select("id")
      .single<ResearchJobRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to queue research job.");
    }

    return data.id;
  }

  private slugify(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/https?:\/\//g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized || `org-${randomUUID()}`;
  }
}