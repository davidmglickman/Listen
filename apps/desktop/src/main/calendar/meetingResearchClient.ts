import type { MeetingResearchBrief } from "@listen/shared";

import { fetchWithTimeout } from "../http/fetchWithTimeout";

export class MeetingResearchClient {
  constructor(private readonly baseUrl: string) {}

  async listMeetingResearch(limit = 100): Promise<MeetingResearchBrief[]> {
    const response = await fetchWithTimeout(`${this.baseUrl}/api/admin/research/meetings?limit=${limit}`);
    if (!response.ok) {
      throw new Error(`Meeting research lookup failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { meetings?: MeetingResearchBrief[] };
    return payload.meetings ?? [];
  }
}