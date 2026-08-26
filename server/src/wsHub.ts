import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Request } from "express";
import { isAuthed } from "./auth";

export class StatusHub {
  private clients = new Set<WebSocket>();
  private wss: WebSocketServer | null = null;

  attach(server: Server, sessionParser: (req: IncomingMessage, res: unknown, next: () => void) => void): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (socket, req) => {
      sessionParser(req, {}, () => {
        const r = req as IncomingMessage & Request;
        if (!isAuthed(r)) {
          socket.close(4401, "auth required");
          return;
        }
        this.clients.add(socket);
        socket.on("close", () => this.clients.delete(socket));
      });
    });
  }

  broadcast(obj: unknown): void {
    const raw = JSON.stringify(obj);
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) {
        try {
          c.send(raw);
        } catch {
          /* ignore */
        }
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
