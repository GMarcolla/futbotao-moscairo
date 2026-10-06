export type PlayingTeam = "moscow" | "cairo";
export type Team = PlayingTeam | "spectator";

export interface RoomSettings {
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

// ---- Mensagens ----

export type ClientMessage =
  | { t: "join"; name: string }
  | { t: "team"; team: Team }
  | { t: "ready"; ready: boolean }
  | { t: "settings"; settings: RoomSettings }
  /** `s` numera os comandos para a predição no cliente. */
  | { t: "input"; i: number; s: number }
  | { t: "chat"; n: number }
  | { t: "ping"; c: number };

export type ServerMessage =
  | { t: "welcome"; id: string }
  | { t: "lobby"; s: LobbyState }
  | { t: "snap"; s: Snapshot }
  | { t: "goal"; g: GoalInfo }
  | { t: "ended"; r: MatchResult }
  | { t: "chat"; num: number; n: number }
  | { t: "pong"; c: number }
  | { t: "error"; message: string };
