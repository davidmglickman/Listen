import type { ListenOutboundEvent } from "@listen/shared";
import WebSocket, { type RawData } from "ws";

export class RealtimeClient {
  private socket: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly onEvent: (event: ListenOutboundEvent) => void,
  ) {}

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.once("open", () => {
        this.socket = socket;
        resolve();
      });
      socket.once("error", (error: Error) => {
        reject(error);
      });
      socket.on("message", (payload: RawData) => {
        const parsed = JSON.parse(payload.toString()) as ListenOutboundEvent;
        this.onEvent(parsed);
      });
    });
  }

  isConnected(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  send(event: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.socket.send(JSON.stringify(event));
    return true;
  }

  dispose(): void {
    this.socket?.close();
    this.socket = null;
  }
}
