import {
  type ClientMessage,
  DEFAULT_ICE_SERVERS,
  DEFAULT_SETTINGS,
  type HostEvent,
  type IceServer,
  type LobbyState,
  Match,
  type MatchEvent,
  type MatchResult,
  NAME_MAX_LENGTH,
  type PlayerInfo,
  type PlayingTeam,
  QUICK_CHAT,
  type RoomPhase,
  type RoomSettings,
  SETTINGS_LIMITS,
  type Score,
  type ServerMessage,
  TICK_MS,
  TIMING,
  type Team,
} from "@futbotao/shared";
import { type Connection, Server, routePartykitRequest } from "partyserver";

/** Estado guardado em cada conexão (sobrevive à hibernação do Durable Object). */
interface PlayerState {
  name: string;
  num: number;
  team: Team;
  ready: boolean;
  joinedAt: number;
}

type PlayerConnection = Connection<PlayerState>;

/** Estado da partida P2P guardado no storage: o objeto hiberna durante o jogo. */
interface P2PMatchState {
  matchHostId: string;
  score: Score;
}

const MAX_STEPS_PER_LOOP = 5;
const ICE_TTL_SECONDS = 12 * 60 * 60;

/**
 * Uma sala = um Durable Object. Cuida do lobby e da sinalização WebRTC.
 *
 * - Modo P2P (padrão): a partida roda no navegador de quem criou a sala; aqui
 *   só se repassa a sinalização e se guarda o placar. O objeto hiberna no jogo.
 * - Modo servidor (reserva): a partida roda aqui num loop de 60Hz.
 */
export class Room extends Server<Env> {
  static override options = { hibernate: true };

  private settings: RoomSettings = DEFAULT_SETTINGS;
  private phase: RoomPhase = "lobby";
  private match: Match | null = null;
  private lastResult: MatchResult | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private loopLastTime = 0;
  private loopAccumulator = 0;
  private countdown: ReturnType<typeof setTimeout> | null = null;
  private countdownEndsAt = 0;
  private p2p: P2PMatchState | null = null;
  private iceCache: { servers: IceServer[]; expiresAt: number } | null = null;

  override async onStart() {
    const saved = await this.ctx.storage.get<RoomSettings>("settings");
    if (saved) this.settings = { ...DEFAULT_SETTINGS, ...saved };
    this.lastResult = (await this.ctx.storage.get<MatchResult>("lastResult")) ?? null;
    const p2p = await this.ctx.storage.get<P2PMatchState>("p2p");
    // Acordou da hibernação no meio de uma partida P2P.
    if (p2p && this.getConnection(p2p.matchHostId)) {
      this.p2p = p2p;
      this.phase = "match";
    } else if (p2p) {
      await this.ctx.storage.delete("p2p");
    }
  }

  override async onConnect(conn: PlayerConnection) {
    this.send(conn, { t: "welcome", id: conn.id, ice: await this.iceServers() });
    this.send(conn, { t: "lobby", s: this.lobbyState() });
  }

  override onClose(conn: PlayerConnection) {
    if (!conn.state) return;
    this.match?.removePlayer(conn.id);
    if (this.p2p?.matchHostId === conn.id) {
      this.broadcastMsg({ t: "error", message: "Quem hospedava a partida saiu. Partida encerrada." });
      this.finishMatch();
      return;
    }
    this.afterRosterChange();
  }

  override onMessage(conn: PlayerConnection, raw: string | ArrayBuffer | ArrayBufferView) {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    if (msg.t === "join") return this.handleJoin(conn, msg.name);
    if (msg.t === "ping") return this.send(conn, { t: "pong", c: msg.c });

    const state = conn.state;
    if (!state) return;
    switch (msg.t) {
      case "input":
        if (Number.isInteger(msg.i)) {
          const seq = Number.isInteger(msg.s) ? msg.s : 0;
          this.match?.setInput(conn.id, msg.i & 63, seq);
        }
        break;
      case "team":
        this.handleTeam(conn, state, msg.team);
        break;
      case "ready":
        if (this.phase === "match" || state.team === "spectator") return;
        conn.setState({ ...state, ready: msg.ready === true });
        this.afterRosterChange();
        break;
      case "settings":
        this.handleSettings(conn, msg.settings);
        break;
      case "chat":
        if (Number.isInteger(msg.n) && msg.n >= 0 && msg.n < QUICK_CHAT.length) {
          this.broadcastMsg({ t: "chat", num: state.num, n: msg.n });
        }
        break;
      case "signal": {
        // Repassa ofertas/respostas/candidatos WebRTC só entre o host e os outros.
        const hostId = this.p2p?.matchHostId;
        if (!hostId || (conn.id !== hostId && msg.to !== hostId)) return;
        const target = this.getConnection<PlayerState>(msg.to);
        if (target) this.send(target, { t: "signal", from: conn.id, data: msg.data });
        break;
      }
      case "hostEvent":
        if (this.p2p?.matchHostId === conn.id) this.handleHostEvent(msg.e);
        break;
    }
  }

  // ---- Lobby ----

  private handleJoin(conn: PlayerConnection, rawName: unknown) {
    const name = typeof rawName === "string" ? rawName.trim().slice(0, NAME_MAX_LENGTH) : "";
    if (!name) return this.send(conn, { t: "error", message: "Apelido inválido." });
    if (conn.state) {
      conn.setState({ ...conn.state, name });
    } else {
      const nums = this.joined().map((c) => c.state!.num);
      conn.setState({
        name,
        num: nums.length ? Math.max(...nums) + 1 : 1,
        team: "spectator",
        ready: false,
        joinedAt: Date.now(),
      });
    }
    this.broadcastLobby();
  }

  private handleTeam(conn: PlayerConnection, state: PlayerState, team: Team) {
    if (team !== "moscow" && team !== "cairo" && team !== "spectator") return;
    if (team === state.team) return;
    if (this.phase === "match" && team !== "spectator") {
      // Durante a partida só pode entrar no time com menos (ou igual) jogadores.
      const counts = this.teamCounts(conn.id);
      const otherTeam: PlayingTeam = team === "moscow" ? "cairo" : "moscow";
      if (counts[team] > counts[otherTeam]) {
        return this.send(conn, { t: "error", message: "Esse time já está com mais jogadores." });
      }
    }
    conn.setState({ ...state, team, ready: false });
    if (this.match) {
      this.match.removePlayer(conn.id);
      if (team !== "spectator") this.match.addPlayer(conn.id, state.num, state.name, team);
    }
    this.afterRosterChange();
  }

  private handleSettings(conn: PlayerConnection, s: RoomSettings) {
    if (this.phase !== "lobby" || this.hostId() !== conn.id || !s) return;
    const clamp = (v: unknown, lim: { min: number; max: number }, fallback: number) =>
      typeof v === "number" && Number.isFinite(v)
        ? Math.min(lim.max, Math.max(lim.min, Math.round(v)))
        : fallback;
    this.settings = {
      network: s.network === "server" ? "server" : "p2p",
      timeLimitMin: clamp(s.timeLimitMin, SETTINGS_LIMITS.timeLimitMin, this.settings.timeLimitMin),
      scoreLimit: clamp(s.scoreLimit, SETTINGS_LIMITS.scoreLimit, this.settings.scoreLimit),
      dashCooldownSec: clamp(
        s.dashCooldownSec,
        SETTINGS_LIMITS.dashCooldownSec,
        this.settings.dashCooldownSec,
      ),
    };
    void this.ctx.storage.put("settings", this.settings);
    this.broadcastLobby();
  }

  /** Reavalia contagem regressiva / partida depois de qualquer mudança de jogadores. */
  private afterRosterChange() {
    const counts = this.teamCounts();
    if (this.phase === "match") {
      if (counts.moscow + counts.cairo === 0) this.finishMatch();
    } else {
      const playing = this.joined().filter((c) => c.state!.team !== "spectator");
      const allReady =
        counts.moscow > 0 && counts.cairo > 0 && playing.every((c) => c.state!.ready);
      if (allReady && this.phase === "lobby") this.startCountdown();
      if (!allReady && this.phase === "countdown") this.cancelCountdown();
    }
    this.broadcastLobby();
  }

  private startCountdown() {
    this.phase = "countdown";
    this.countdownEndsAt = Date.now() + TIMING.countdownMs;
    this.countdown = setTimeout(() => this.startMatch(), TIMING.countdownMs);
  }

  private cancelCountdown() {
    if (this.countdown) clearTimeout(this.countdown);
    this.countdown = null;
    this.phase = "lobby";
  }

  // ---- Partida ----

  private startMatch() {
    this.countdown = null;
    this.phase = "match";
    this.lastResult = null;
    void this.ctx.storage.delete("lastResult");
    const hostId = this.hostId();
    if (this.settings.network === "p2p" && hostId) {
      // O navegador do host roda a partida; os outros conectam nele.
      this.p2p = { matchHostId: hostId, score: { moscow: 0, cairo: 0 } };
      void this.ctx.storage.put("p2p", this.p2p);
      this.broadcastLobby();
      return;
    }
    this.match = new Match({ ...this.settings });
    for (const c of this.joined()) {
      const s = c.state!;
      if (s.team !== "spectator") this.match.addPlayer(c.id, s.num, s.name, s.team);
    }
    this.loopLastTime = Date.now();
    this.loopAccumulator = 0;
    this.loop = setInterval(() => this.runLoop(), TICK_MS);
    this.broadcastLobby();
  }

  private runLoop() {
    const match = this.match;
    if (!match) return;
    const now = Date.now();
    this.loopAccumulator += now - this.loopLastTime;
    this.loopLastTime = now;
    let steps = 0;
    while (this.loopAccumulator >= TICK_MS && steps < MAX_STEPS_PER_LOOP) {
      this.loopAccumulator -= TICK_MS;
      steps++;
      for (const event of match.step()) {
        this.handleMatchEvent(event);
        if (this.match !== match) return;
      }
    }
    // Se o servidor engasgou, descarta o atraso em vez de acelerar o jogo.
    if (steps === MAX_STEPS_PER_LOOP) this.loopAccumulator = 0;
    if (steps > 0) this.broadcastMsg({ t: "snap", s: match.snapshot() });
  }

  private handleMatchEvent(event: MatchEvent) {
    switch (event.type) {
      case "goal":
        this.broadcastMsg({ t: "goal", g: event.goal });
        this.broadcastLobby();
        break;
      case "ended":
        this.lastResult = event.result;
        this.broadcastMsg({ t: "ended", r: event.result });
        break;
      case "finished":
        this.finishMatch();
        break;
    }
  }

  private handleHostEvent(e: HostEvent) {
    const p2p = this.p2p!;
    switch (e?.type) {
      case "goal":
        p2p.score = { moscow: e.goal.score.moscow | 0, cairo: e.goal.score.cairo | 0 };
        void this.ctx.storage.put("p2p", p2p);
        this.broadcastLobby();
        break;
      case "ended":
        this.lastResult = e.result;
        void this.ctx.storage.put("lastResult", e.result);
        break;
      case "finished":
        this.finishMatch();
        break;
    }
  }

  private finishMatch() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.match = null;
    if (this.p2p) {
      this.p2p = null;
      void this.ctx.storage.delete("p2p");
    }
    this.phase = "lobby";
    for (const c of this.joined()) {
      if (c.state!.ready) c.setState({ ...c.state!, ready: false });
    }
    this.broadcastLobby();
  }

  // ---- Utilitários ----

  private joined(): PlayerConnection[] {
    return [...this.getConnections<PlayerState>()].filter((c) => c.state !== null);
  }

  private teamCounts(excludeId?: string): Record<PlayingTeam, number> {
    const counts = { moscow: 0, cairo: 0 };
    for (const c of this.joined()) {
      const team = c.state!.team;
      if (c.id !== excludeId && team !== "spectator") counts[team]++;
    }
    return counts;
  }

  /** Quem entrou primeiro ajusta as configurações da sala. */
  private hostId(): string | null {
    let host: PlayerConnection | null = null;
    for (const c of this.joined()) {
      if (!host || c.state!.joinedAt < host.state!.joinedAt) host = c;
    }
    return host?.id ?? null;
  }

  private lobbyState(): LobbyState {
    const players: PlayerInfo[] = this.joined()
      .sort((a, b) => a.state!.joinedAt - b.state!.joinedAt)
      .map((c) => ({
        id: c.id,
        num: c.state!.num,
        name: c.state!.name,
        team: c.state!.team,
        ready: c.state!.ready,
      }));
    return {
      phase: this.phase,
      hostId: this.hostId(),
      matchHostId: this.p2p?.matchHostId ?? null,
      players,
      settings: this.settings,
      score: this.match
        ? { ...this.match.score }
        : (this.p2p?.score ?? { moscow: 0, cairo: 0 }),
      countdownMs:
        this.phase === "countdown" ? Math.max(0, this.countdownEndsAt - Date.now()) : null,
      lastResult: this.lastResult,
    };
  }

  /**
   * Servidores ICE para o WebRTC. Com os segredos TURN_KEY_ID e TURN_KEY_API_TOKEN
   * configurados, inclui o TURN da Cloudflare (para redes que bloqueiam conexão direta).
   */
  private async iceServers(): Promise<IceServer[]> {
    const { TURN_KEY_ID, TURN_KEY_API_TOKEN } = this.env as Env & {
      TURN_KEY_ID?: string;
      TURN_KEY_API_TOKEN?: string;
    };
    if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) return DEFAULT_ICE_SERVERS;
    if (this.iceCache && this.iceCache.expiresAt > Date.now()) return this.iceCache.servers;
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: ICE_TTL_SECONDS }),
        },
      );
      if (!res.ok) throw new Error(`TURN ${res.status}`);
      const { iceServers } = (await res.json()) as { iceServers: IceServer[] };
      // A porta 53 alternativa é bloqueada pelos navegadores e só atrasa a conexão.
      const servers = iceServers.map((s) => ({
        ...s,
        urls: ([] as string[]).concat(s.urls).filter((u) => !u.includes(":53?")),
      }));
      this.iceCache = { servers, expiresAt: Date.now() + (ICE_TTL_SECONDS / 2) * 1000 };
      return servers;
    } catch (err) {
      console.error("Falha ao gerar credenciais TURN", err);
      return DEFAULT_ICE_SERVERS;
    }
  }

  private broadcastLobby() {
    this.broadcastMsg({ t: "lobby", s: this.lobbyState() });
  }

  private broadcastMsg(msg: ServerMessage) {
    this.broadcast(JSON.stringify(msg));
  }

  private send(conn: PlayerConnection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env)) ??
      new Response("futbotão: servidor de salas", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
