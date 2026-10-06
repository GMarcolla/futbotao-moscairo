import { PHYSICS, STADIUM, TEAMS } from "./constants";
import { type Disc, Mask, STADIUM_GEOMETRY, collideDiscs, collideSegment } from "./physics";
import { Input, type PlayingTeam } from "./types";

/**
 * Estado de um jogador controlado pelo teclado. Usado pelo servidor (autoridade)
 * e pelo cliente (predição do próprio movimento), para os dois andarem igual.
 */
export interface ControlledPlayer extends Disc {
  team: PlayingTeam;
  input: number;
  /** Chute já usado neste aperto; só libera ao soltar o botão. */
  kickConsumed: boolean;
  /** Toque rápido no chute entre dois ticks não pode se perder. */
  kickQueued: boolean;
  dashQueued: boolean;
  dashCooldown: number;
  dashTicks: number;
}

export function createPlayer(team: PlayingTeam, x: number, y: number): ControlledPlayer {
  return {
    team,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: PHYSICS.player.radius,
    invMass: PHYSICS.player.invMass,
    bCoef: PHYSICS.player.bCoef,
    damping: PHYSICS.player.damping,
    input: 0,
    kickConsumed: false,
    kickQueued: false,
    dashQueued: false,
    dashCooldown: 0,
    dashTicks: 0,
  };
}

/** Registra o novo estado do teclado, guardando os "apertos" para o próximo tick. */
export function pressInput(p: ControlledPlayer, input: number): void {
  const pressed = input & ~p.input;
  if (pressed & Input.kick) p.kickQueued = true;
  if (pressed & Input.dash) p.dashQueued = true;
  p.input = input;
}

/** Aceleração e dash de um tick (o chute é tratado pela partida). */
export function applyControls(p: ControlledPlayer, dashCooldownTicks: number): void {
  const cfg = PHYSICS.player;
  let dx = 0;
  let dy = 0;
  if (p.input & Input.left) dx -= 1;
  if (p.input & Input.right) dx += 1;
  if (p.input & Input.up) dy -= 1;
  if (p.input & Input.down) dy += 1;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    dx /= len;
    dy /= len;
    const acc = p.input & Input.kick ? cfg.kickingAcceleration : cfg.acceleration;
    p.vx += dx * acc;
    p.vy += dy * acc;
  }

  if (p.dashCooldown > 0) p.dashCooldown--;
  if (p.dashTicks > 0) p.dashTicks--;
  // Dash parado não faz nada e não gasta a recarga.
  if (p.dashQueued && p.dashCooldown === 0 && len > 0) {
    p.vx += dx * PHYSICS.dash.impulse;
    p.vy += dy * PHYSICS.dash.impulse;
    p.dashCooldown = dashCooldownTicks;
    p.dashTicks = PHYSICS.dash.visualTicks;
  }
  p.dashQueued = false;
}

export function createBall(): Disc {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: PHYSICS.ball.radius,
    invMass: PHYSICS.ball.invMass,
    bCoef: PHYSICS.ball.bCoef,
    damping: PHYSICS.ball.damping,
  };
}

/**
 * Chute de um tick: segurando o botão (ou num toque rápido) chuta uma vez
 * quando a bola está ao alcance; só chuta de novo depois de soltar.
 * Retorna true se chutou.
 */
export function applyKick(p: ControlledPlayer, ball: Disc): boolean {
  const holdingKick = (p.input & Input.kick) !== 0;
  let kicked = false;
  if ((holdingKick || p.kickQueued) && !p.kickConsumed) {
    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist - p.radius - ball.radius < PHYSICS.player.kickRange) {
      const strength = PHYSICS.player.kickStrength * ball.invMass;
      ball.vx += (dx / (dist || 1)) * strength;
      ball.vy += (dy / (dist || 1)) * strength;
      p.kickConsumed = true;
      kicked = true;
    }
  }
  p.kickQueued = false;
  if (!holdingKick) p.kickConsumed = false;
  return kicked;
}

/** Colisão da bola com traves, linhas do campo e redes. */
export function collideBallWithStadium(ball: Disc): void {
  for (const post of STADIUM_GEOMETRY.posts) collideDiscs(post, ball);
  for (const s of STADIUM_GEOMETRY.segments) {
    if (s.mask & Mask.ball) collideSegment(ball, s);
  }
}

/** Colisão do jogador com traves, redes e limite externo. */
export function collidePlayerWithStadium(p: Disc): void {
  for (const post of STADIUM_GEOMETRY.posts) collideDiscs(post, p);
  for (const s of STADIUM_GEOMETRY.segments) {
    if (s.mask & Mask.player) collideSegment(p, s);
  }
}

/**
 * Na saída de bola cada um fica no seu campo; quem não tem a saída
 * também não pode entrar no círculo central.
 */
export function applyKickoffLimits(p: ControlledPlayer, kickoffTeam: PlayingTeam): void {
  const side = TEAMS[p.team].side;
  const R = STADIUM.centerRadius;
  const insideCircle = Math.hypot(p.x, p.y) < R;
  if (side * p.x < p.radius && !(p.team === kickoffTeam && insideCircle)) {
    p.x = side * p.radius;
    p.vx = 0;
  }
  if (p.team !== kickoffTeam) {
    const dist = Math.hypot(p.x, p.y);
    const min = R + p.radius;
    if (dist < min) {
      const nx = dist > 0 ? p.x / dist : side;
      const ny = dist > 0 ? p.y / dist : 0;
      p.x = nx * min;
      p.y = ny * min;
      p.vx = p.vy = 0;
    }
  }
}
