import type { CallFunction, MeetingContext } from "./types";

export const CALL_FUNCTION_OPTIONS: CallFunction[] = ["sales", "recruiting", "partnership", "internal"];

export const CALL_TYPE_OPTIONS: Record<CallFunction, string[]> = {
  sales: ["outbound prospecting", "discovery call", "demo", "follow-up", "negotiation", "renewal"],
  recruiting: ["recruiter screen", "hiring manager screen", "panel interview", "closing call"],
  partnership: ["intro call", "qualification", "solution alignment", "negotiation"],
  internal: ["1:1", "pipeline review", "forecast call", "project sync", "performance discussion"],
};

export const DEFAULT_MEETING_CONTEXT: MeetingContext = {
  callFunction: "sales",
  callType: "discovery call",
  callGoal: "book discovery",
  userRole: "AE",
  guestRole: "prospect",
  desiredOutcome: "Leave with a scheduled next step.",
  notes: "",
};