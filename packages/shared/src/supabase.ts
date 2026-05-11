import { z } from "zod";

const CallFunctionSchema = z.enum(["sales", "recruiting", "partnership", "internal"]);
const CoachingScopeSchema = z.enum(["org", "user"]);

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