import { z } from "zod";

const CallFunctionSchema = z.enum(["sales", "recruiting", "partnership", "internal"]);
const CoachingScopeSchema = z.enum(["org", "user"]);
export const AuthProviderSchema = z.enum(["google", "email"]);
export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);
export const ProfileStatusSchema = z.enum(["invited", "active", "disabled"]);
export const InvitationStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);

export const ResearchStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export const ResearchSourceSchema = z.enum(["calendar", "manual", "linkedin_url", "company_domain", "crm", "other"]);

export const ProspectOrganizationSchema = z.object({
  externalId: z.string().min(1).optional(),
  name: z.string().min(1),
  domain: z.string().min(1).optional(),
  linkedInUrl: z.string().url().optional(),
  description: z.string().optional(),
  industry: z.string().optional(),
});

export const ProspectPersonSchema = z.object({
  externalId: z.string().min(1).optional(),
  fullName: z.string().min(1),
  email: z.string().email().optional(),
  title: z.string().optional(),
  linkedInUrl: z.string().url().optional(),
  organizationDomain: z.string().optional(),
  organizationName: z.string().optional(),
});

export const SyncedMeetingContextSchema = z.object({
  callFunction: CallFunctionSchema,
  callType: z.string().min(1),
  callGoal: z.string().min(1),
  userRole: z.string().min(1),
  guestRole: z.string().min(1),
  desiredOutcome: z.string().min(1),
  notes: z.string(),
});

export const MeetingSyncRecordSchema = z.object({
  externalId: z.string().min(1).optional(),
  title: z.string().min(1),
  startsAt: z.string(),
  endsAt: z.string(),
  source: ResearchSourceSchema.default("calendar"),
  organizerEmail: z.string().email().optional(),
  joinUrl: z.string().url().optional(),
  notes: z.string().optional(),
  context: SyncedMeetingContextSchema.nullable().optional(),
});

export const MeetingAttendeeSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional(),
  title: z.string().optional(),
  linkedInUrl: z.string().url().optional(),
  organizationDomain: z.string().optional(),
  organizationName: z.string().optional(),
  role: z.enum(["host", "internal", "guest"]).default("guest"),
});

export const CalendarSyncRequestSchema = z.object({
  organization: ProspectOrganizationSchema.optional(),
  meeting: MeetingSyncRecordSchema,
  attendees: z.array(MeetingAttendeeSchema).default([]),
  userId: z.string().uuid().optional(),
});

export const ResearchJobRecordSchema = z.object({
  id: z.string().uuid().optional(),
  meetingId: z.string().uuid(),
  personId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  status: ResearchStatusSchema,
  source: ResearchSourceSchema,
  lookupKey: z.string().min(1),
  error: z.string().optional(),
});

export const ResearchSnapshotSchema = z.object({
  personSummary: z.string().optional(),
  organizationSummary: z.string().optional(),
  recentSignals: z.array(z.string()).default([]),
  linkedInUrl: z.string().url().optional(),
  references: z.array(z.string().url()).default([]),
  rawPayload: z.record(z.unknown()).default({}),
});

export const CompleteResearchJobRequestSchema = z.object({
  status: z.enum(["completed", "failed"]),
  snapshot: ResearchSnapshotSchema.optional(),
  error: z.string().optional(),
});

export const MeetingResearchBriefSchema = z.object({
  meetingExternalId: z.string().min(1),
  status: ResearchStatusSchema,
  personSummary: z.string().optional(),
  organizationSummary: z.string().optional(),
  recentSignals: z.array(z.string()).default([]),
  linkedInUrl: z.string().url().optional(),
  sourceLinks: z.array(z.string().url()).default([]),
  updatedAt: z.string().optional(),
});

export const SupabaseCoachingProfileSchema = z.object({
  id: z.string().uuid().optional(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  scope: CoachingScopeSchema,
  label: z.string().min(1),
  guidance: z.string().min(1),
});

export const SupabaseProfileSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  email: z.string().email().nullable().optional(),
  fullName: z.string().nullable().optional(),
  role: OrganizationRoleSchema,
  status: ProfileStatusSchema.default("active"),
});

export const SupabaseUserInvitationSchema = z.object({
  id: z.string().uuid().optional(),
  organizationId: z.string().uuid(),
  email: z.string().email(),
  role: OrganizationRoleSchema.default("member"),
  status: InvitationStatusSchema.default("pending"),
  invitedBy: z.string().uuid().nullable().optional(),
  acceptedUserId: z.string().uuid().nullable().optional(),
  expiresAt: z.string(),
  lastSentAt: z.string().optional(),
});

export const SupabaseConnectedAccountSchema = z.object({
  id: z.string().uuid().optional(),
  profileId: z.string().uuid(),
  provider: AuthProviderSchema,
  providerSubject: z.string().min(1),
  providerEmail: z.string().email().nullable().optional(),
  scopes: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

export type ProspectOrganization = z.infer<typeof ProspectOrganizationSchema>;
export type ProspectPerson = z.infer<typeof ProspectPersonSchema>;
export type SyncedMeetingContext = z.infer<typeof SyncedMeetingContextSchema>;
export type MeetingSyncRecord = z.infer<typeof MeetingSyncRecordSchema>;
export type MeetingAttendee = z.infer<typeof MeetingAttendeeSchema>;
export type CalendarSyncRequest = z.infer<typeof CalendarSyncRequestSchema>;
export type ResearchJobRecord = z.infer<typeof ResearchJobRecordSchema>;
export type ResearchSnapshot = z.infer<typeof ResearchSnapshotSchema>;
export type CompleteResearchJobRequest = z.infer<typeof CompleteResearchJobRequestSchema>;
export type MeetingResearchBriefPayload = z.infer<typeof MeetingResearchBriefSchema>;
export type SupabaseCoachingProfile = z.infer<typeof SupabaseCoachingProfileSchema>;
export type AuthProvider = z.infer<typeof AuthProviderSchema>;
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;
export type SupabaseProfile = z.infer<typeof SupabaseProfileSchema>;
export type SupabaseUserInvitation = z.infer<typeof SupabaseUserInvitationSchema>;
export type SupabaseConnectedAccount = z.infer<typeof SupabaseConnectedAccountSchema>;