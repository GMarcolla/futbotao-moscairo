export type PlayingTeam = "moscow" | "cairo";
export type Team = PlayingTeam | "spectator";

/**
 * Onde a partida roda:
 * - "p2p": no navegador de quem criou a sala; os outros conectam direto nele (WebRTC).
 * - "server": no servidor da Cloudflare (reserva, para redes que bloqueiam P2P).
 */
export type NetworkMode = "p2p" | "server";

export interface RoomSettings {
  network: NetworkMode;
  timeLimitMin: number;
  /** 0 = sem limite de gols. */
  scoreLimit: number;
  dashCooldownSec: number;
}

export type Score = Record<PlayingTeam, number>;

/** Bits do estado do teclado enviado pelo cliente. */
export const Input = {
  up: 1,
  down: 2,
  left: 4,
  right: 8,
  kick: 16,
  dash: 32,
} as const;

/** Fase da sala (gerenciada pelo servidor). */
export type RoomPhase = "lobby" | "countdown" | "match";

/** Fase interna da partida (gerenciada pela simulação). */
export type MatchPhase = "playing" | "goal" | "replay" | "ended";

export interface PlayerInfo {
  id: string;
  /** Identificador numérico curto, usado nos snapshots. */
  num: number;
  name: string;
  team: Team;
  ready: boolean;
}

export interface MatchResult {
  score: Score;
  winner: PlayingTeam | null;
}

export interface LobbyState {
  phase: RoomPhase;
  hostId: string | null;
  /** Quem roda a partida atual no modo P2P (null no modo servidor ou fora de partida). */
  matchHostId: string | null;
  players: PlayerInfo[];
  settings: RoomSettings;
  score: Score;
  /** Ms restantes da contagem regressiva, quando phase === "countdown". */
  countdownMs: number | null;
  lastResult: MatchResult | null;
}

/** Flags por jogador no snapshot. */
export const PlayerFlag = {
  kickArmed: 1,
  dashing: 2,
} as const;

/**
 * [num, x, y, flags, recargaDoDash (ticks restantes), vx, vy,
 *  último comando processado (seq), ticks desde que esse comando passou a valer]
 */
export type PlayerSnap = [number, number, number, number, number, number, number, number, number];

export interface Snapshot {
  /** Tick da simulação. */
  k: number;
  ph: MatchPhase;
  /** Tempo de jogo decorrido, em ticks. */
  t: number;
  /** 1 se está na prorrogação (gol de ouro). */
  ot: 0 | 1;
  /** Time que dá a saída de bola enquanto ela não foi tocada, senão null. */
  ko: PlayingTeam | null;
  /** Bola: [x, y, vx, vy]. */
  b: [number, number, number, number];
  p: PlayerSnap[];
}

export interface GoalInfo {
  /** Time que marcou o ponto. */
  team: PlayingTeam;
  scorer: string | null;
  assist: string | null;
  ownGoal: boolean;
  tick: number;
  score: Score;
}

// ---- Mensagens com o servidor (lobby, sinalização e modo servidor) ----

/** Dados de sinalização WebRTC repassados pelo servidor entre dois navegadores. */
export type SignalData =
  | { sdp: { type: "offer" | "answer"; sdp: string } }
  | { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } };

/** O host P2P avisa o servidor do que importa para o lobby. */
export type HostEvent =
  | { type: "goal"; goal: GoalInfo }
  | { type: "ended"; result: MatchResult }
  | { type: "finished" };

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ClientMessage =
  | { t: "join"; name: string }
  | { t: "team"; team: Team }
  | { t: "ready"; ready: boolean }
  | { t: "settings"; settings: RoomSettings }
  /** `s` numera os comandos para a predição no cliente. */
  | { t: "input"; i: number; s: number }
  | { t: "chat"; n: number }
  | { t: "ping"; c: number }
  | { t: "signal"; to: string; data: SignalData }
  | { t: "hostEvent"; e: HostEvent };

export type ServerMessage =
  | { t: "welcome"; id: string; ice: IceServer[] }
  | { t: "lobby"; s: LobbyState }
  | { t: "snap"; s: Snapshot }
  | { t: "goal"; g: GoalInfo }
  | { t: "ended"; r: MatchResult }
  | { t: "chat"; num: number; n: number }
  | { t: "pong"; c: number }
  | { t: "signal"; from: string; data: SignalData }
  | { t: "error"; message: string };

// ---- Mensagens P2P entre o host e os outros navegadores ----

export type GuestMessage = { t: "input"; i: number; s: number } | { t: "ping"; c: number };

export type HostMessage =
  | { t: "snap"; s: Snapshot }
  | { t: "goal"; g: GoalInfo }
  | { t: "ended"; r: MatchResult }
  | { t: "pong"; c: number };
