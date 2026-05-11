import { EventEmitter } from "node:events";

import type { MeetingRecord } from "@listen/shared";

export interface MeetingSchedulerEvents {
  popup: (meeting: MeetingRecord) => void;
}

export class MeetingScheduler extends EventEmitter {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly leadMinutes: number) {
    super();
  }

  setMeetings(meetings: MeetingRecord[]): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    const now = Date.now();
    for (const meeting of meetings) {
      const popupAt = new Date(meeting.startsAt).getTime() - this.leadMinutes * 60_000;
      const delay = Math.max(popupAt - now, 0);
      const timer = setTimeout(() => {
        this.emit("popup", meeting);
      }, delay);
      this.timers.set(meeting.id, timer);
    }
  }
}
