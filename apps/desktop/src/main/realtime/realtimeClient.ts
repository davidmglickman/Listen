import type { ListenOutboundEvent } from "@listen/shared";
import WebSocket, { type RawData } from "ws";

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly onEvent: (event: ListenOutboundEvent) => void,
  ) {}

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const resetSocket = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
      };

      this.socket = socket;
      socket.once("open", () => {
        this.socket = socket;
        this.connectPromise = null;
        resolve();
      });
      socket.once("error", (error: Error) => {
        resetSocket();
        this.connectPromise = null;
        reject(error);
      });
      socket.on("close", () => {
        resetSocket();
        this.connectPromise = null;
      });
      socket.on("error", () => {
        // Errors are surfaced through the connect promise or close handling.
      });
      socket.on("message", (payload: RawData) => {
        const parsed = JSON.parse(payload.toString()) as ListenOutboundEvent;
        this.onEvent(parsed);
      });
    });

    return this.connectPromise;
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
