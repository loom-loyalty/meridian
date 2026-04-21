/**
 * WebSocket transport for Meridian wire protocol.
 * Manages connections, reconnection, and frame dispatch.
 */

import type { Frame, AgentId } from "@loom-loyalty/meridian-types";
import { encode, decode } from "./codec.js";

export type FrameHandler = (frame: Frame) => void | Promise<void>;

export interface TransportOptions {
  url: string;
  agentId: AgentId;
  /** Reconnect on disconnect. Default true. */
  autoReconnect?: boolean;
  /** Max reconnect delay in ms. Default 30000. */
  maxReconnectDelay?: number;
  /** Handler called on every incoming frame. */
  onFrame: FrameHandler;
  /** Handler called on connection state changes. */
  onStateChange?: (state: "connecting" | "connected" | "disconnected") => void;
}

export class MeridianTransport {
  private ws: WebSocket | null = null;
  private opts: Required<TransportOptions>;
  private reconnectAttempts = 0;
  private closed = false;

  constructor(opts: TransportOptions) {
    this.opts = {
      autoReconnect: true,
      maxReconnectDelay: 30_000,
      onStateChange: () => {},
      ...opts,
    };
  }

  /** Open the WebSocket connection. */
  async connect(): Promise<void> {
    this.closed = false;
    return this.doConnect();
  }

  /** Send a frame over the wire. */
  async send(frame: Frame): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Transport not connected");
    }
    const bytes = encode(frame);
    this.ws.send(bytes);
  }

  /** Gracefully close the connection. */
  close(): void {
    this.closed = true;
    this.ws?.close(1000, "client close");
    this.ws = null;
    this.opts.onStateChange("disconnected");
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.opts.onStateChange("connecting");

      const ws = new WebSocket(this.opts.url);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        this.ws = ws;
        this.reconnectAttempts = 0;
        this.opts.onStateChange("connected");
        resolve();
      });

      ws.addEventListener("message", (event) => {
        const data = new Uint8Array(event.data as ArrayBuffer);
        const frame = decode(data);
        this.opts.onFrame(frame);
      });

      ws.addEventListener("close", () => {
        this.ws = null;
        this.opts.onStateChange("disconnected");
        if (!this.closed && this.opts.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      ws.addEventListener("error", (err) => {
        if (!this.ws) {
          reject(new Error("WebSocket connection failed"));
        }
      });
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const baseDelay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.opts.maxReconnectDelay
    );
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = baseDelay + jitter;

    setTimeout(() => {
      if (!this.closed) {
        this.doConnect().catch(() => {
          // Retry handled by the close event
        });
      }
    }, delay);
  }
}
