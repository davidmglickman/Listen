import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdminOrganizationSummary,
  AdminManagedUser,
  AdminUserDirectory,
  AdminUserInvitation,
  AppAuthUser,
  CalendarSyncRequest,
  CompleteResearchJobRequest,
  MeetingAttendee,
  MeetingResearchBrief,
  ProspectOrganization,
  ResearchSnapshot,
} from "@listen/shared";

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "mail.com",
]);

interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  status: "active" | "disabled";
  max_users: number | null;
}

interface ProfileRow {
  id: string;
  organization_id: string;
  email: string | null;
  full_name: string | null;
  role: AppAuthUser["role"];
  status: AppAuthUser["status"];
  created_at?: string | null;
  updated_at?: string | null;
}

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: AdminUserInvitation["role"];
  status: AdminUserInvitation["status"];
  expires_at: string;
  last_sent_at: string | null;
  accepted_user_id: string | null;
  created_at?: string | null;
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
  private readonly superAdminEmails: Set<string>;
  private readonly desktopDownloadUrl: string | null;

  constructor(
    private readonly client: SupabaseClient | null,
    private readonly defaultOrganizationSlug: string,
    options?: { superAdminEmails?: string[]; desktopDownloadUrl?: string | null },
  ) {
    this.superAdminEmails = new Set((options?.superAdminEmails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean));
    this.desktopDownloadUrl = options?.desktopDownloadUrl?.trim() || null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async getAuthenticatedProfile(accessToken: string): Promise<AppAuthUser | null> {
    const result = await this.getAuthenticatedProfileResult(accessToken);
    return result.profile;
  }

  async getAuthenticatedProfileResult(accessToken: string): Promise<{ profile: AppAuthUser | null; reason: string | null }> {
    const authUser = await this.getVerifiedAuthUser(accessToken);
    if (!authUser) {
      return { profile: null, reason: null };
    }

    const superAdminProfile = this.getSuperAdminProfile(authUser);
    if (superAdminProfile) {
      return { profile: superAdminProfile, reason: null };
    }

    const existingProfile = await this.getProfileById(authUser.id, authUser.email ?? null, authUser.user_metadata ?? null);
    if (existingProfile) {
      return this.resolveAuthenticatedProfileAccess(existingProfile);
    }

    return this.bootstrapAuthenticatedProfile(authUser);
  }

  async listOrganizationUsers(accessToken: string, requestedOrganizationId?: string | null): Promise<AdminUserDirectory> {
    const viewer = await this.requireAdminViewer(accessToken);
    const organizations = await this.listOrganizationsForViewer(viewer);
    const organizationId = this.resolveManagedOrganizationId(viewer, organizations, requestedOrganizationId);
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    if (!organizationId) {
      return {
        viewer,
        organizations,
        selectedOrganizationId: null,
        users: [],
        invitations: [],
      };
    }

    const [{ data: users, error: usersError }, { data: invitations, error: invitationsError }] = await Promise.all([
      this.client
        .from("profiles")
        .select("id, organization_id, email, full_name, role, status, created_at, updated_at")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: true }),
      this.client
        .from("user_invitations")
        .select("id, organization_id, email, role, status, expires_at, last_sent_at, accepted_user_id")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false }),
    ]);

    if (usersError) {
      throw new Error(usersError.message);
    }
    if (invitationsError) {
      throw new Error(invitationsError.message);
    }

    return {
      viewer,
      organizations,
      selectedOrganizationId: organizationId,
      users: ((users ?? []) as ProfileRow[]).map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        email: row.email ?? null,
        fullName: row.full_name ?? null,
        role: row.role ?? "member",
        status: row.status ?? "active",
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
      } satisfies AdminManagedUser)),
      invitations: ((invitations ?? []) as InvitationRow[]).map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        email: row.email,
        role: row.role,
        status: row.status,
        expiresAt: row.expires_at,
        lastSentAt: row.last_sent_at,
        acceptedUserId: row.accepted_user_id,
      } satisfies AdminUserInvitation)),
    };
  }

  async listManageableOrganizations(accessToken: string): Promise<AdminOrganizationSummary[]> {
    const viewer = await this.requireAdminViewer(accessToken);
    return this.listOrganizationsForViewer(viewer);
  }

  async createOrganization(accessToken: string, payload: { name: string; adminEmail: string; maxUsers?: number | null }): Promise<AdminOrganizationSummary> {
    const viewer = await this.requireAdminViewer(accessToken);
    if (!viewer.isSuperAdmin) {
      throw new Error("Super-admin access is required.");
    }
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const name = payload.name.trim();
    const adminEmail = payload.adminEmail.trim().toLowerCase();
    const maxUsers = typeof payload.maxUsers === "number" && Number.isFinite(payload.maxUsers) && payload.maxUsers > 0
      ? Math.floor(payload.maxUsers)
      : null;
    if (!name || !adminEmail) {
      throw new Error("Organization name and admin email are required.");
    }

    const organizationId = await this.upsertOrganization({
      name,
      status: "active",
      maxUsers,
    });

    const { error } = await this.client
      .from("user_invitations")
      .upsert(
        {
          organization_id: organizationId,
          email: adminEmail,
          role: "owner",
          status: "pending",
          invite_token_hash: randomUUID(),
          invited_by: viewer.organizationId ? viewer.id : null,
          accepted_user_id: null,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          last_sent_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,email" },
      );

    if (error) {
      throw new Error(error.message);
    }

    return this.getOrganizationSummaryById(organizationId);
  }

  async updateOrganization(
    accessToken: string,
    organizationId: string,
    payload: { status?: "active" | "disabled"; maxUsers?: number | null },
  ): Promise<AdminOrganizationSummary> {
    const viewer = await this.requireAdminViewer(accessToken);
    if (!viewer.isSuperAdmin) {
      throw new Error("Super-admin access is required.");
    }
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const patch: { status?: "active" | "disabled"; max_users?: number | null } = {};
    if (payload.status === "active" || payload.status === "disabled") {
      patch.status = payload.status;
    }
    if (typeof payload.maxUsers === "number" && Number.isFinite(payload.maxUsers) && payload.maxUsers > 0) {
      patch.max_users = Math.floor(payload.maxUsers);
    }
    if (payload.maxUsers === null) {
      patch.max_users = null;
    }
    if (!Object.keys(patch).length) {
      throw new Error("No valid organization updates were provided.");
    }

    const { error } = await this.client
      .from("organizations")
      .update(patch)
      .eq("id", organizationId);

    if (error) {
      throw new Error(error.message);
    }

    return this.getOrganizationSummaryById(organizationId);
  }

  async inviteOrganizationUser(
    accessToken: string,
    payload: { email: string; role: AdminUserInvitation["role"]; organizationId?: string | null },
  ): Promise<AdminUserInvitation> {
    const viewer = await this.requireAdminViewer(accessToken);
    const organizations = await this.listOrganizationsForViewer(viewer);
    const organizationId = this.resolveManagedOrganizationId(viewer, organizations, payload.organizationId);
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }
    if (!organizationId) {
      throw new Error("Select an organization before inviting users.");
    }

    const email = payload.email.trim().toLowerCase();
    if (!email) {
      throw new Error("Email is required.");
    }

    await this.ensureOrganizationInviteCapacity(organizationId);

    const role = payload.role === "owner" || payload.role === "admin" ? payload.role : "member";
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const inviteTokenHash = randomUUID();

    const { data, error } = await this.client
      .from("user_invitations")
      .upsert(
        {
          organization_id: organizationId,
          email,
          role,
          status: "pending",
          invite_token_hash: inviteTokenHash,
          invited_by: viewer.organizationId ? viewer.id : null,
          accepted_user_id: null,
          expires_at: expiresAt,
          last_sent_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,email" },
      )
      .select("id, organization_id, email, role, status, expires_at, last_sent_at, accepted_user_id")
      .single<InvitationRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to create invitation.");
    }

    return {
      id: data.id,
      organizationId: data.organization_id,
      email: data.email,
      role: data.role,
      status: data.status,
      expiresAt: data.expires_at,
      lastSentAt: data.last_sent_at,
      acceptedUserId: data.accepted_user_id,
    };
  }

  async updateOrganizationInvitation(
    accessToken: string,
    invitationId: string,
    action: "resend" | "revoke",
    requestedOrganizationId?: string | null,
  ): Promise<AdminUserInvitation> {
    const viewer = await this.requireAdminViewer(accessToken);
    const organizations = await this.listOrganizationsForViewer(viewer);
    const organizationId = this.resolveManagedOrganizationId(viewer, organizations, requestedOrganizationId);
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }
    if (!organizationId) {
      throw new Error("Select an organization before updating invitations.");
    }

    const { data: existingInvitation, error: existingInvitationError } = await this.client
      .from("user_invitations")
      .select("id, organization_id, email, role, status, expires_at, last_sent_at, accepted_user_id, created_at")
      .eq("id", invitationId)
      .eq("organization_id", organizationId)
      .maybeSingle<InvitationRow>();

    if (existingInvitationError) {
      throw new Error(existingInvitationError.message);
    }
    if (!existingInvitation) {
      throw new Error("Invitation was not found.");
    }
    if (existingInvitation.accepted_user_id || existingInvitation.status === "accepted") {
      throw new Error("Accepted invitations can no longer be updated.");
    }

    const patch = action === "revoke"
      ? { status: "revoked" as const }
      : {
          status: "pending" as const,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          last_sent_at: new Date().toISOString(),
          invite_token_hash: randomUUID(),
        };

    const { data, error } = await this.client
      .from("user_invitations")
      .update(patch)
      .eq("id", invitationId)
      .eq("organization_id", organizationId)
      .select("id, organization_id, email, role, status, expires_at, last_sent_at, accepted_user_id")
      .single<InvitationRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to update invitation.");
    }

    return {
      id: data.id,
      organizationId: data.organization_id,
      email: data.email,
      role: data.role,
      status: data.status,
      expiresAt: data.expires_at,
      lastSentAt: data.last_sent_at,
      acceptedUserId: data.accepted_user_id,
    };
  }

  async updateOrganizationUser(
    accessToken: string,
    profileId: string,
    payload: { role?: AdminManagedUser["role"]; status?: AdminManagedUser["status"]; organizationId?: string | null },
  ): Promise<AdminManagedUser> {
    const viewer = await this.requireAdminViewer(accessToken);
    const organizations = await this.listOrganizationsForViewer(viewer);
    const organizationId = this.resolveManagedOrganizationId(viewer, organizations, payload.organizationId);
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }
    if (!organizationId) {
      throw new Error("Select an organization before updating users.");
    }

    const patch: Record<string, string> = {};
    if (payload.role === "owner" || payload.role === "admin" || payload.role === "member") {
      patch.role = payload.role;
    }
    if (payload.status === "invited" || payload.status === "active" || payload.status === "disabled") {
      patch.status = payload.status;
    }
    if (!Object.keys(patch).length) {
      throw new Error("No valid user updates were provided.");
    }

    const { data, error } = await this.client
      .from("profiles")
      .update(patch)
      .eq("id", profileId)
      .eq("organization_id", organizationId)
      .select("id, organization_id, email, full_name, role, status, created_at, updated_at")
      .single<ProfileRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to update user.");
    }

    return {
      id: data.id,
      organizationId: data.organization_id,
      email: data.email ?? null,
      fullName: data.full_name ?? null,
      role: data.role ?? "member",
      status: data.status ?? "active",
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
    };
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

  private async getVerifiedAuthUser(accessToken: string): Promise<{ id: string; email?: string | null; user_metadata?: Record<string, unknown> | null } | null> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const token = accessToken.trim();
    if (!token) {
      return null;
    }

    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data.user) {
      return null;
    }

    return {
      id: data.user.id,
      email: data.user.email ?? null,
      user_metadata: (data.user.user_metadata ?? null) as Record<string, unknown> | null,
    };
  }

  private async getProfileById(
    profileId: string,
    fallbackEmail: string | null,
    userMetadata: Record<string, unknown> | null,
  ): Promise<AppAuthUser | null> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { data, error } = await this.client
      .from("profiles")
      .select("id, organization_id, email, full_name, role, status")
      .eq("id", profileId)
      .maybeSingle<ProfileRow>();

    if (error) {
      throw new Error(error.message);
    }

    const fullName = typeof userMetadata?.full_name === "string"
      ? userMetadata.full_name
      : typeof userMetadata?.name === "string"
        ? userMetadata.name
        : null;

    if (!data) {
      return null;
    }

    return {
      id: data.id,
      organizationId: data.organization_id,
      email: data.email ?? fallbackEmail,
      fullName: data.full_name ?? fullName,
      role: data.role ?? null,
      status: data.status ?? null,
    };
  }

  private async requireAdminViewer(accessToken: string): Promise<AppAuthUser> {
    const profile = await this.getAuthenticatedProfile(accessToken);
    if (!profile) {
      throw new Error("Authenticated profile was not found.");
    }
    if (profile.isSuperAdmin) {
      return profile;
    }
    if (!profile.organizationId) {
      throw new Error("Authenticated profile was not found.");
    }
    if (profile.role !== "owner" && profile.role !== "admin") {
      throw new Error("Admin access is required.");
    }

    return profile;
  }

  private async bootstrapAuthenticatedProfile(
    authUser: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null },
  ): Promise<{ profile: AppAuthUser | null; reason: string | null }> {
    const normalizedEmail = authUser.email?.trim().toLowerCase() || null;
    const fullName = this.getAuthUserFullName(authUser.user_metadata ?? null);

    if (!normalizedEmail) {
      return {
        profile: null,
        reason: "Listen sign-in requires an email address from your login provider.",
      };
    }

    const invitationLookup = await this.findInvitationByEmail(normalizedEmail);
    if (invitationLookup.invitation) {
      const profile = await this.createProfileFromInvitation(authUser.id, normalizedEmail, fullName, invitationLookup.invitation);
      return this.resolveAuthenticatedProfileAccess(profile);
    }
    if (invitationLookup.reason) {
      return { profile: null, reason: invitationLookup.reason };
    }

    const initialOwner = await this.createInitialOwnerProfile(authUser.id, normalizedEmail, fullName);
    if (initialOwner) {
      return this.resolveAuthenticatedProfileAccess(initialOwner);
    }

    const selfSignupProfile = await this.createSelfSignupProfile(authUser.id, normalizedEmail, fullName);
    return this.resolveAuthenticatedProfileAccess(selfSignupProfile);

  }

  private async createSelfSignupProfile(authUserId: string, email: string, fullName: string | null): Promise<AppAuthUser> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const emailDomain = this.getEmailDomain(email);
    const existingOrganization = emailDomain && !PERSONAL_EMAIL_DOMAINS.has(emailDomain)
      ? await this.getOrganizationByDomain(emailDomain)
      : null;
    const organizationId = existingOrganization?.id
      ?? await this.upsertOrganization({
        name: this.buildSelfSignupOrganizationName(email, fullName, emailDomain),
        domain: emailDomain && !PERSONAL_EMAIL_DOMAINS.has(emailDomain) ? emailDomain : undefined,
      });

    await this.ensureOrganizationInviteCapacity(organizationId);

    const existingMemberCount = await this.getOrganizationProfileCount(organizationId);
    const role: AppAuthUser["role"] = existingMemberCount > 0 ? "member" : "owner";

    const { data, error } = await this.client
      .from("profiles")
      .upsert(
        {
          id: authUserId,
          organization_id: organizationId,
          email,
          full_name: fullName,
          role,
          status: "active",
        },
        { onConflict: "id" },
      )
      .select("id, organization_id, email, full_name, role, status")
      .single<ProfileRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to create profile from first-visit sign-in.");
    }

    return {
      id: data.id,
      organizationId: data.organization_id,
      email: data.email ?? email,
      fullName: data.full_name ?? fullName,
      role: data.role ?? role,
      status: data.status ?? "active",
    };
  }

  private async findInvitationByEmail(email: string): Promise<{ invitation: InvitationRow | null; reason: string | null }> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { data, error } = await this.client
      .from("user_invitations")
      .select("id, organization_id, email, role, status, expires_at, last_sent_at, accepted_user_id, created_at")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<InvitationRow>();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      return { invitation: null, reason: null };
    }

    const organization = await this.getOrganizationById(data.organization_id);
    if (organization?.status === "disabled") {
      return {
        invitation: null,
        reason: "This organization is disabled. Contact Listen support to re-enable it.",
      };
    }
    if (data.status === "revoked") {
      return {
        invitation: null,
        reason: "Your Listen invitation was revoked. Ask an organization admin to send a new one.",
      };
    }
    if (new Date(data.expires_at).getTime() < Date.now()) {
      return {
        invitation: null,
        reason: "Your Listen invitation expired. Ask an organization admin to resend it.",
      };
    }

    if (data.status !== "pending" && data.status !== "accepted") {
      return { invitation: null, reason: null };
    }

    return { invitation: data, reason: null };
  }

  private async createProfileFromInvitation(
    authUserId: string,
    email: string,
    fullName: string | null,
    invitation: InvitationRow,
  ): Promise<AppAuthUser> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { data, error } = await this.client
      .from("profiles")
      .upsert(
        {
          id: authUserId,
          organization_id: invitation.organization_id,
          email,
          full_name: fullName,
          role: invitation.role,
          status: "active",
        },
        { onConflict: "id" },
      )
      .select("id, organization_id, email, full_name, role, status")
      .single<ProfileRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to create profile from invitation.");
    }

    await this.client
      .from("user_invitations")
      .update({
        status: "accepted",
        accepted_user_id: authUserId,
      })
      .eq("id", invitation.id);

    return {
      id: data.id,
      organizationId: data.organization_id,
      email: data.email ?? email,
      fullName: data.full_name ?? fullName,
      role: data.role ?? invitation.role,
      status: data.status ?? "active",
    };
  }

  private async createInitialOwnerProfile(authUserId: string, email: string | null, fullName: string | null): Promise<AppAuthUser | null> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { count, error: countError } = await this.client
      .from("profiles")
      .select("id", { count: "exact", head: true });

    if (countError) {
      throw new Error(countError.message);
    }
    if ((count ?? 0) > 0) {
      return null;
    }

    const organizationId = await this.upsertOrganization({
      name: this.defaultOrganizationSlug,
    });

    const { data, error } = await this.client
      .from("profiles")
      .upsert(
        {
          id: authUserId,
          organization_id: organizationId,
          email,
          full_name: fullName,
          role: "owner",
          status: "active",
        },
        { onConflict: "id" },
      )
      .select("id, organization_id, email, full_name, role, status")
      .single<ProfileRow>();

    if (error || !data) {
      throw new Error(error?.message ?? "Failed to create initial owner profile.");
    }

    return {
      id: data.id,
      organizationId: data.organization_id,
      email: data.email ?? email,
      fullName: data.full_name ?? fullName,
      role: data.role ?? "owner",
      status: data.status ?? "active",
    };
  }

  private async resolveAuthenticatedProfileAccess(profile: AppAuthUser): Promise<{ profile: AppAuthUser | null; reason: string | null }> {
    if (profile.organizationId) {
      const organization = await this.getOrganizationById(profile.organizationId);
      if (organization?.status === "disabled") {
        return {
          profile: null,
          reason: "This organization is disabled. Contact Listen support to re-enable it.",
        };
      }
    }

    if (profile.status === "disabled") {
      return {
        profile: null,
        reason: "This Listen account is disabled. Ask an organization owner to re-enable it.",
      };
    }

    return {
      profile,
      reason: null,
    };
  }

  private getSuperAdminProfile(authUser: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null }): AppAuthUser | null {
    const normalizedEmail = authUser.email?.trim().toLowerCase() || null;
    if (!normalizedEmail || !this.superAdminEmails.has(normalizedEmail)) {
      return null;
    }

    return {
      id: authUser.id,
      organizationId: null,
      email: normalizedEmail,
      fullName: this.getAuthUserFullName(authUser.user_metadata ?? null),
      role: "owner",
      status: "active",
      isSuperAdmin: true,
    };
  }

  private resolveManagedOrganizationId(
    viewer: AppAuthUser,
    organizations: AdminOrganizationSummary[],
    requestedOrganizationId?: string | null,
  ): string | null {
    if (viewer.isSuperAdmin) {
      if (requestedOrganizationId && organizations.some((organization) => organization.id === requestedOrganizationId)) {
        return requestedOrganizationId;
      }
      return organizations[0]?.id ?? null;
    }

    if (!viewer.organizationId) {
      return null;
    }
    if (requestedOrganizationId && requestedOrganizationId !== viewer.organizationId) {
      throw new Error("Admin access is limited to your organization.");
    }

    return viewer.organizationId;
  }

  private async listOrganizationsForViewer(viewer: AppAuthUser): Promise<AdminOrganizationSummary[]> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const organizationsQuery = this.client
      .from("organizations")
      .select("id, slug, name, domain, status, max_users")
      .order("name", { ascending: true });

    const { data: organizationRows, error: organizationError } = viewer.isSuperAdmin
      ? await organizationsQuery
      : await organizationsQuery.eq("id", viewer.organizationId ?? "");

    if (organizationError) {
      throw new Error(organizationError.message);
    }

    const organizations = (organizationRows ?? []) as OrganizationRow[];
    if (!organizations.length) {
      return [];
    }

    const organizationIds = organizations.map((organization) => organization.id);
    const [{ data: profiles, error: profilesError }, { data: invitations, error: invitationsError }] = await Promise.all([
      this.client
        .from("profiles")
        .select("id, organization_id, email, full_name, role, status, created_at")
        .in("organization_id", organizationIds),
      this.client
        .from("user_invitations")
        .select("id, organization_id, email, role, status, created_at")
        .in("organization_id", organizationIds),
    ]);

    if (profilesError) {
      throw new Error(profilesError.message);
    }
    if (invitationsError) {
      throw new Error(invitationsError.message);
    }

    const profileRows = (profiles ?? []) as Array<ProfileRow & { created_at?: string | null }>;
    const invitationRows = (invitations ?? []) as Array<InvitationRow & { created_at?: string | null }>;

    return organizations.map((organization) => {
      const orgProfiles = profileRows.filter((profile) => profile.organization_id === organization.id);
      const orgInvitations = invitationRows.filter((invitation) => invitation.organization_id === organization.id);
      const adminProfile = orgProfiles
        .filter((profile) => (profile.role === "owner" || profile.role === "admin") && profile.status !== "disabled")
        .sort((left, right) => {
          const roleRank = this.getAdminRoleRank(left.role) - this.getAdminRoleRank(right.role);
          if (roleRank !== 0) {
            return roleRank;
          }
          return new Date(left.created_at ?? 0).getTime() - new Date(right.created_at ?? 0).getTime();
        })[0] ?? null;
      const pendingAdminInvitation = orgInvitations
        .filter((invitation) => invitation.status === "pending" && (invitation.role === "owner" || invitation.role === "admin"))
        .sort((left, right) => {
          const roleRank = this.getAdminRoleRank(left.role) - this.getAdminRoleRank(right.role);
          if (roleRank !== 0) {
            return roleRank;
          }
          return new Date(left.created_at ?? 0).getTime() - new Date(right.created_at ?? 0).getTime();
        })[0] ?? null;

      return {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
        domain: organization.domain,
        status: organization.status,
        maxUsers: organization.max_users,
        userCount: orgProfiles.length,
        pendingInvitationCount: orgInvitations.filter((invitation) => invitation.status === "pending").length,
        adminUserId: adminProfile?.id ?? null,
        adminEmail: adminProfile?.email ?? pendingAdminInvitation?.email ?? null,
        adminFullName: adminProfile?.full_name ?? null,
        adminRole: adminProfile?.role === "owner" || adminProfile?.role === "admin"
          ? adminProfile.role
          : pendingAdminInvitation?.role === "owner" || pendingAdminInvitation?.role === "admin"
            ? pendingAdminInvitation.role
            : null,
        downloadUrl: this.buildOrganizationDownloadUrl(organization.slug),
      } satisfies AdminOrganizationSummary;
    });
  }

  private async getOrganizationSummaryById(organizationId: string): Promise<AdminOrganizationSummary> {
    const summary = (await this.listOrganizationsForIds([organizationId]))[0] ?? null;
    if (!summary) {
      throw new Error("Organization was not found.");
    }
    return summary;
  }

  private async listOrganizationsForIds(organizationIds: string[]): Promise<AdminOrganizationSummary[]> {
    const viewer: AppAuthUser = {
      id: "system",
      organizationId: null,
      email: null,
      fullName: null,
      role: "owner",
      status: "active",
      isSuperAdmin: true,
    };
    const organizations = await this.listOrganizationsForViewer(viewer);
    return organizations.filter((organization) => organizationIds.includes(organization.id));
  }

  private async getOrganizationById(organizationId: string): Promise<OrganizationRow | null> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { data, error } = await this.client
      .from("organizations")
      .select("id, slug, name, domain, status, max_users")
      .eq("id", organizationId)
      .maybeSingle<OrganizationRow>();

    if (error) {
      throw new Error(error.message);
    }

    return data ?? null;
  }

  private async ensureOrganizationInviteCapacity(organizationId: string): Promise<void> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const organization = await this.getOrganizationById(organizationId);
    if (!organization) {
      throw new Error("Organization was not found.");
    }
    if (organization.status === "disabled") {
      throw new Error("This organization is disabled.");
    }
    if (!organization.max_users) {
      return;
    }

    const [{ count: profileCount, error: profileError }, { count: invitationCount, error: invitationError }] = await Promise.all([
      this.client.from("profiles").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
      this.client.from("user_invitations").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "pending"),
    ]);

    if (profileError) {
      throw new Error(profileError.message);
    }
    if (invitationError) {
      throw new Error(invitationError.message);
    }

    if ((profileCount ?? 0) + (invitationCount ?? 0) >= organization.max_users) {
      throw new Error("This organization has reached its user limit.");
    }
  }

  private async getOrganizationByDomain(domain: string): Promise<OrganizationRow | null> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { data, error } = await this.client
      .from("organizations")
      .select("id, slug, name, domain, status, max_users")
      .ilike("domain", domain)
      .maybeSingle<OrganizationRow>();

    if (error) {
      throw new Error(error.message);
    }

    return data ?? null;
  }

  private async getOrganizationProfileCount(organizationId: string): Promise<number> {
    if (!this.client) {
      throw new Error("Supabase is not configured.");
    }

    const { count, error } = await this.client
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);

    if (error) {
      throw new Error(error.message);
    }

    return count ?? 0;
  }

  private getAdminRoleRank(role: AppAuthUser["role"]): number {
    if (role === "owner") {
      return 0;
    }
    if (role === "admin") {
      return 1;
    }
    return 2;
  }

  private buildOrganizationDownloadUrl(slug: string): string | null {
    if (!this.desktopDownloadUrl) {
      return null;
    }

    const joiner = this.desktopDownloadUrl.includes("?") ? "&" : "?";
    return `${this.desktopDownloadUrl}${joiner}org=${encodeURIComponent(slug)}`;
  }

  private getAuthUserFullName(userMetadata: Record<string, unknown> | null): string | null {
    return typeof userMetadata?.full_name === "string"
      ? userMetadata.full_name
      : typeof userMetadata?.name === "string"
        ? userMetadata.name
        : null;
  }

  private async upsertOrganization(
    organization: ProspectOrganization & { status?: "active" | "disabled"; maxUsers?: number | null },
  ): Promise<string> {
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
          status: organization.status ?? "active",
          max_users: organization.maxUsers ?? null,
        },
        { onConflict: "slug" },
      )
      .select("id, slug, name, domain, status, max_users")
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

  private getEmailDomain(email: string): string | null {
    const [, domain = ""] = email.trim().toLowerCase().split("@");
    return domain || null;
  }

  private buildSelfSignupOrganizationName(email: string, fullName: string | null, emailDomain: string | null): string {
    if (emailDomain && !PERSONAL_EMAIL_DOMAINS.has(emailDomain)) {
      const rootLabel = emailDomain.split(".")[0] || emailDomain;
      return rootLabel
        .split(/[-_]+/)
        .filter(Boolean)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(" ") || emailDomain;
    }

    return fullName?.trim() || email;
  }
}