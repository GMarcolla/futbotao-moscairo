import type {
  ClientMessage,
  HostEvent,
  HostMessage,
  IceServer,
  LobbyState,
  MatchEvent,
  SignalData,
} from "@futbotao/shared";
import { GuestLink, HostHub, type LinkState } from "./p2p";
import type { FromWorker, RosterEntry, ToWorker } from "./sim.worker";

/** Tempo para desistir de conectar no host e sugerir o modo servidor. */
const CONNECT_TIMEOUT_MS = 12000;
const PING_INTERVAL_MS = 2000;

export interface SessionHooks {
  myId: string;
  ice: IceServer[];
  /** Mensagem para o servidor da sala (lobby/sinalização). */
  sendServer(msg: ClientMessage): void;
  /** Snapshot ou evento da partida, venha de onde vier. */
  onMatchMessage(msg: HostMessage): void;
  /** Texto de status da conexão (null = tudo certo). */
  onStatus(text: string | null): void;
  onPing(ms: number | null, label: string): void;
}

/** Uma partida em andamento, do ponto de vista deste navegador. */
export interface MatchSession {
  sendInput(bits: number, seq: number): void;
  onLobby(state: LobbyState): void;
  onSignal(from: string, data: SignalData): void;
  close(): void;
}

export function createSession(state: LobbyState, hooks: SessionHooks): MatchSession {
  if (!state.matchHostId) return new ServerSession(hooks);
  if (state.matchHostId === hooks.myId) return new HostSession(state, hooks);
  return new GuestSession(state.matchHostId, hooks);
}

/** Modo servidor: a partida roda na Cloudflare; tudo passa pelo WebSocket da sala. */
class ServerSession implements MatchSession {
  constructor(private readonly hooks: SessionHooks) {
    hooks.onStatus(null);
  }

  sendInput(bits: number, seq: number) {
    this.hooks.sendServer({ t: "input", i: bits, s: seq });
  }

  onLobby() {}
  onSignal() {}
  close() {}
}

/** Este navegador hospeda: roda a partida num Worker e repassa aos outros. */
class HostSession implements MatchSession {
  private readonly worker: Worker;
  private readonly hub: HostHub;

  constructor(state: LobbyState, private readonly hooks: SessionHooks) {
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.hub = new HostHub(
      hooks.ice,
      (to, data) => hooks.sendServer({ t: "signal", to, data }),
      (from, msg) => {
        if (msg.t === "input") this.post({ t: "input", id: from, i: msg.i, s: msg.s });
        else if (msg.t === "ping") this.hub.sendTo(from, { t: "pong", c: msg.c });
      },
    );
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
    this.post({ t: "start", settings: state.settings });
    this.onLobby(state);
    hooks.onStatus(null);
    hooks.onPing(0, "você hospeda a partida");
  }

  sendInput(bits: number, seq: number) {
    this.post({ t: "input", id: this.hooks.myId, i: bits, s: seq });
  }

  onLobby(state: LobbyState) {
    const players: RosterEntry[] = [];
    for (const p of state.players) {
      if (p.team !== "spectator") players.push({ id: p.id, num: p.num, name: p.name, team: p.team });
    }
    this.post({ t: "roster", players });
  }

  onSignal(from: string, data: SignalData) {
    void this.hub.onSignal(from, data);
  }

  close() {
    this.post({ t: "stop" });
    this.worker.terminate();
    this.hub.close();
  }

  private post(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  private onWorker(msg: FromWorker) {
    if (msg.t === "snap") {
      const out: HostMessage = { t: "snap", s: msg.s };
      this.hooks.onMatchMessage(out);
      this.hub.broadcastSnap(JSON.stringify(out));
      return;
    }
    const e: MatchEvent = msg.e;
    let hostEvent: HostEvent;
    if (e.type === "goal") {
      const out: HostMessage = { t: "goal", g: e.goal };
      this.hooks.onMatchMessage(out);
      this.hub.broadcastReliable(out);
      hostEvent = { type: "goal", goal: e.goal };
    } else if (e.type === "ended") {
      const out: HostMessage = { t: "ended", r: e.result };
      this.hooks.onMatchMessage(out);
      this.hub.broadcastReliable(out);
      hostEvent = { type: "ended", result: e.result };
    } else {
      hostEvent = { type: "finished" };
    }
    // O servidor guarda placar/resultado e devolve todos ao lobby no fim.
    this.hooks.sendServer({ t: "hostEvent", e: hostEvent });
  }
}

/** Este navegador joga (ou assiste) conectado direto no host. */
class GuestSession implements MatchSession {
  private readonly link: GuestLink;
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly pinger: ReturnType<typeof setInterval>;

  constructor(hostId: string, private readonly hooks: SessionHooks) {
    hooks.onStatus("Conectando direto em quem hospeda a partida…");
    this.link = new GuestLink(
      hostId,
      hooks.ice,
      (to, data) => hooks.sendServer({ t: "signal", to, data }),
      (msg) => {
        if (msg.t === "pong") hooks.onPing(Math.round(performance.now() - msg.c), "P2P");
        else hooks.onMatchMessage(msg);
      },
      (state) => this.onLinkState(state),
    );
    this.timeout = setTimeout(() => {
      if (this.link.state !== "open") this.onLinkState("failed");
    }, CONNECT_TIMEOUT_MS);
    this.pinger = setInterval(() => this.link.send({ t: "ping", c: performance.now() }), PING_INTERVAL_MS);
  }

  sendInput(bits: number, seq: number) {
    this.link.send({ t: "input", i: bits, s: seq });
  }

  onLobby() {}

  onSignal(_from: string, data: SignalData) {
    void this.link.onSignal(data).catch((err) => console.error("Sinalização WebRTC", err));
  }

  close() {
    clearTimeout(this.timeout);
    clearInterval(this.pinger);
    this.link.close();
  }

  private onLinkState(state: LinkState) {
    if (state === "open") {
      clearTimeout(this.timeout);
      this.hooks.onStatus(null);
    } else if (state === "failed") {
      this.hooks.onStatus(
        "Não deu para conectar direto em quem hospeda (a rede pode estar bloqueando P2P). " +
          "Peça para quem criou a sala mudar a Rede para \"Servidor\".",
      );
    }
  }
}
