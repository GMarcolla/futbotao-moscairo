import type { ClientMessage, ServerMessage } from "@futbotao/shared";
import PartySocket from "partysocket";

export interface Net {
  send(msg: ClientMessage): void;
  readonly connected: boolean;
}

export function connect(
  room: string,
  handlers: {
    onOpen(): void;
    onClose(): void;
    onMessage(msg: ServerMessage): void;
  },
): Net {
  const socket = new PartySocket({
    host: import.meta.env.VITE_PARTY_HOST || "localhost:8787",
    party: "room",
    room,
  });
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("close", () => handlers.onClose());
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      handlers.onMessage(JSON.parse(event.data) as ServerMessage);
    } catch (err) {
      console.error("Mensagem inválida do servidor", err);
    }
  });
  return {
    send(msg) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
    get connected() {
      return socket.readyState === WebSocket.OPEN;
    },
  };
}
