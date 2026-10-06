import type { PlayingTeam, RoomSettings } from "./types";

/** Simulação roda a 60 passos por segundo (igual ao HaxBall). */
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

/**
 * Dimensões do estádio em "pixels de mundo". Origem no centro do campo.
 * Moscow defende o gol da esquerda (x < 0), Cairo o da direita (x > 0).
 */
export const STADIUM = {
  /** Metade da largura do campo (linha de fundo em x = ±halfWidth). */
  halfWidth: 550,
  /** Metade da altura do campo (laterais em y = ±halfHeight). */
  halfHeight: 250,
  /** Metade da abertura do gol (traves em y = ±goalHalfWidth). */
  goalHalfWidth: 75,
  /** Profundidade da rede atrás da linha de fundo. */
  goalDepth: 45,
  /** Quanto o jogador pode sair além das linhas (a bola não pode). */
  playerMargin: 60,
  /** Raio do círculo central (respeitado na saída de bola). */
  centerRadius: 80,
} as const;

export const PHYSICS = {
  player: {
    radius: 15,
    invMass: 0.5,
    bCoef: 0.5,
    /**
     * Mais ágil que o HaxBall original (0.96 / 0.1 / 0.07): chega na velocidade
     * máxima em ~0,5s e para em ~0,7s.
     */
    damping: 0.92,
    acceleration: 0.26,
    /** Segurando o chute o jogador fica mais lento, como no HaxBall. */
    kickingAcceleration: 0.18,
    kickStrength: 5,
    /** Distância extra (além do encosto) em que o chute ainda pega na bola. */
    kickRange: 4,
  },
  ball: {
    radius: 10,
    invMass: 1,
    bCoef: 0.5,
    damping: 0.99,
  },
  post: {
    radius: 8,
    bCoef: 0.5,
  },
  /** Coeficiente de quique das paredes da bola e da rede. */
  wallBCoef: 1,
  /** Coeficiente de quique do limite externo dos jogadores. */
  playerWallBCoef: 0.5,
  dash: {
    /** Velocidade somada na direção do movimento (~75px a mais, 2,5 corpos). */
    impulse: 6,
    /** Por quantos ticks o dash fica "visível" (rastro). */
    visualTicks: 12,
  },
} as const;

/** Tempos das fases da partida, em ticks. */
export const TIMING = {
  /** Comemoração após o gol, com a física ainda rodando. */
  goalCelebrationTicks: 90,
  /** Duração do replay (a física fica congelada). */
  replayTicks: 360,
  /** Tela de fim de jogo antes de voltar ao lobby. */
  endedTicks: 300,
  /** Contagem regressiva no lobby antes da partida começar (ms). */
  countdownMs: 3000,
} as const;

/**
 * Janela gravada do replay, relativa ao tick do gol.
 * Trecho [start, slowFrom) toca em velocidade normal e [slowFrom, end] em câmera lenta.
 * Total: 3s normais + 1,5s de jogo a 0,5x = 6s, igual a TIMING.replayTicks.
 */
export const REPLAY = {
  startOffsetTicks: -240,
  slowFromOffsetTicks: -60,
  endOffsetTicks: 30,
  slowFactor: 0.5,
} as const;

export const DEFAULT_SETTINGS: RoomSettings = {
  network: "p2p",
  timeLimitMin: 3,
  scoreLimit: 3,
  dashCooldownSec: 10,
};

export const SETTINGS_LIMITS = {
  timeLimitMin: { min: 1, max: 10 },
  /** 0 = sem limite de gols. */
  scoreLimit: { min: 0, max: 10 },
  dashCooldownSec: { min: 3, max: 20 },
} as const;

export const TEAMS: Record<PlayingTeam, { name: string; color: string; side: -1 | 1 }> = {
  moscow: { name: "Moscow", color: "#c8102e", side: -1 },
  cairo: { name: "Cairo", color: "#1f5aa6", side: 1 },
};

export const QUICK_CHAT = ["Passa!", "Boa!", "Foi mal 😅", "GOOOL!"] as const;

export const NAME_MAX_LENGTH = 16;

/** Usados quando o servidor não tem TURN configurado (só conexão direta). */
export const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];
