import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import type { WSEventMessage } from "./types.ts";

const WS_MAGIC_STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WebSocketBroadcaster {
  private clients: Set<Socket> = new Set();

  public handleUpgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptValue = createHash("sha1")
      .update(key + WS_MAGIC_STRING)
      .digest("base64");

    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptValue}`,
      "\r\n",
    ].join("\r\n");

    socket.write(responseHeaders);
    this.clients.add(socket);

    socket.on("close", () => {
      this.clients.delete(socket);
    });

    socket.on("error", () => {
      this.clients.delete(socket);
      socket.destroy();
    });
  }

  public broadcast(message: WSEventMessage): void {
    if (this.clients.size === 0) return;

    const payload = JSON.stringify(message);
    const frame = this.encodeFrame(payload);

    for (const client of this.clients) {
      if (!client.destroyed && client.writable) {
        client.write(frame);
      } else {
        this.clients.delete(client);
      }
    }
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  private encodeFrame(text: string): Buffer {
    const payload = Buffer.from(text, "utf8");
    const length = payload.length;

    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text frame
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([header, payload]);
  }
}
