import { PHYSICS, STADIUM, TEAMS, TICK_RATE, TIMING } from "./constants";
import {
  type Disc,
  Mask,
  STADIUM_GEOMETRY,
  collideDiscs,
  collideSegment,
  integrate,
} from "./physics";
import {
  Input,
  type GoalInfo,
  type MatchPhase,
  type MatchResult,
  PlayerFlag,
  type PlayerSnap,
  type PlayingTeam,
  type RoomSettings,
  type Score,
  type Snapshot,
} from "./types";

export interface MatchPlayer extends Disc {
  id: string;
  num: number;
  name: string;
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

export type MatchEvent =
  | { type: "goal"; goal: GoalInfo }
  | { type: "ended"; result: MatchResult }
  /** Tela de fim acabou: o servidor volta para o lobby. */
  | { type: "finished" };

interface Touch {
  id: string;
  team: PlayingTeam;
}

const other = (team: PlayingTeam): PlayingTeam => (team === "moscow" ? "cairo" : "moscow");
const round1 = (n: number) => Math.round(n * 10) / 10;

export class Match {
  readonly settings: RoomSettings;
  readonly players = new Map<string, MatchPlayer>();
  readonly ball: Disc;
  readonly score: Score = { moscow: 0, cairo: 0 };

  tick = 0;
  phase: MatchPhase = "playing";
  /** Tempo de jogo, em ticks (para durante gol/replay). */
  elapsed = 0;
  overtime = false;
  /** Time que dá a saída enquanto a bola não for tocada. */
  kickoffTeam: PlayingTeam | null;
  result: MatchResult | null = null;

  private nextKickoff: PlayingTeam = "moscow";
  private phaseTicksLeft = 0;
  private touches: Touch[] = [];

  constructor(settings: RoomSettings, kickoffTeam: PlayingTeam = "moscow") {
    this.settings = settings;
    this.kickoffTeam = kickoffTeam;
    this.ball = {
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

  addPlayer(id: string, num: number, name: string, team: PlayingTeam): void {
    const index = this.teamPlayers(team).length;
    const spawn = spawnPosition(team, index);
    this.players.set(id, {
      id,
      num,
      name,
      team,
      x: spawn.x,
      y: spawn.y,
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
    });
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  teamPlayers(team: PlayingTeam): MatchPlayer[] {
    return [...this.players.values()].filter((p) => p.team === team);
  }

  setInput(id: string, input: number): void {
    const p = this.players.get(id);
    if (!p) return;
    const pressed = input & ~p.input;
    if (pressed & Input.kick) p.kickQueued = true;
    if (pressed & Input.dash) p.dashQueued = true;
    p.input = input;
  }

  step(): MatchEvent[] {
    const events: MatchEvent[] = [];
    this.tick++;
    switch (this.phase) {
      case "playing":
        this.simulate(true, events);
        this.elapsed++;
        this.checkTime(events);
        break;
      case "goal":
        this.simulate(false, events);
        if (--this.phaseTicksLeft <= 0) {
          this.phase = "replay";
          this.phaseTicksLeft = TIMING.replayTicks;
        }
        break;
      case "replay":
        if (--this.phaseTicksLeft <= 0) {
          if (this.result) this.end(events);
          else this.resetPositions();
        }
        break;
      case "ended":
        if (--this.phaseTicksLeft <= 0) events.push({ type: "finished" });
        break;
    }
    return events;
  }

  snapshot(): Snapshot {
    const cooldownTicks = this.settings.dashCooldownSec * TICK_RATE;
    const p: PlayerSnap[] = [];
    for (const pl of this.players.values()) {
      let flags = 0;
      if (pl.input & Input.kick && !pl.kickConsumed) flags |= PlayerFlag.kickArmed;
      if (pl.dashTicks > 0) flags |= PlayerFlag.dashing;
      p.push([
        pl.num,
        round1(pl.x),
        round1(pl.y),
        flags,
        Math.round((pl.dashCooldown / cooldownTicks) * 100) / 100,
      ]);
    }
    return {
      k: this.tick,
      ph: this.phase,
      t: this.elapsed,
      ot: this.overtime ? 1 : 0,
      ko: this.kickoffTeam,
      b: [round1(this.ball.x), round1(this.ball.y)],
      p,
    };
  }

  /** Coloca todos nas posições iniciais com a saída para quem sofreu o gol. */
  resetPositions(): void {
    this.phase = "playing";
    this.kickoffTeam = this.nextKickoff;
    this.ball.x = this.ball.y = this.ball.vx = this.ball.vy = 0;
    this.touches = [];
    for (const team of ["moscow", "cairo"] as const) {
      this.teamPlayers(team).forEach((p, i) => {
        const s = spawnPosition(team, i);
        p.x = s.x;
        p.y = s.y;
        p.vx = p.vy = 0;
        p.dashTicks = 0;
      });
    }
  }

  private simulate(allowGoals: boolean, events: MatchEvent[]): void {
    const cfg = PHYSICS.player;
    const cooldownTicks = this.settings.dashCooldownSec * TICK_RATE;

    for (const p of this.players.values()) {
      const holdingKick = (p.input & Input.kick) !== 0;
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
        const acc = holdingKick ? cfg.kickingAcceleration : cfg.acceleration;
        p.vx += dx * acc;
        p.vy += dy * acc;
      }

      if (p.dashCooldown > 0) p.dashCooldown--;
      if (p.dashTicks > 0) p.dashTicks--;
      // Dash parado não faz nada e não gasta a recarga.
      if (p.dashQueued && p.dashCooldown === 0 && len > 0) {
        p.vx += dx * PHYSICS.dash.impulse;
        p.vy += dy * PHYSICS.dash.impulse;
        p.dashCooldown = cooldownTicks;
        p.dashTicks = PHYSICS.dash.visualTicks;
      }
      p.dashQueued = false;

      if ((holdingKick || p.kickQueued) && !p.kickConsumed && this.ballInKickRange(p)) {
        this.kick(p);
        p.kickConsumed = true;
      }
      p.kickQueued = false;
      if (!holdingKick) p.kickConsumed = false;
    }

    integrate(this.ball);
    for (const p of this.players.values()) integrate(p);

    const players = [...this.players.values()];
    for (let i = 0; i < players.length; i++) {
      const a = players[i]!;
      for (let j = i + 1; j < players.length; j++) collideDiscs(a, players[j]!);
      if (collideDiscs(a, this.ball)) this.touch(a);
    }
    for (const post of STADIUM_GEOMETRY.posts) {
      collideDiscs(post, this.ball);
      for (const p of players) collideDiscs(post, p);
    }
    for (const s of STADIUM_GEOMETRY.segments) {
      if (s.mask & Mask.ball) collideSegment(this.ball, s);
      if (s.mask & Mask.player) for (const p of players) collideSegment(p, s);
    }

    if (this.kickoffTeam && this.phase === "playing") {
      if (this.ball.vx !== 0 || this.ball.vy !== 0) this.kickoffTeam = null;
      else for (const p of players) this.applyKickoffLimits(p, this.kickoffTeam);
    }

    if (allowGoals) this.checkGoal(events);
  }

  private ballInKickRange(p: MatchPlayer): boolean {
    const dist = Math.hypot(this.ball.x - p.x, this.ball.y - p.y);
    return dist - p.radius - this.ball.radius < PHYSICS.player.kickRange;
  }

  private kick(p: MatchPlayer): void {
    const dx = this.ball.x - p.x;
    const dy = this.ball.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const strength = PHYSICS.player.kickStrength * this.ball.invMass;
    this.ball.vx += (dx / dist) * strength;
    this.ball.vy += (dy / dist) * strength;
    this.touch(p);
  }

  private touch(p: MatchPlayer): void {
    if (this.touches[0]?.id === p.id) return;
    this.touches.unshift({ id: p.id, team: p.team });
    this.touches.length = Math.min(this.touches.length, 2);
  }

  /**
   * Na saída de bola cada um fica no seu campo; quem não tem a saída
   * também não pode entrar no círculo central.
   */
  private applyKickoffLimits(p: MatchPlayer, kickoffTeam: PlayingTeam): void {
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

  private checkGoal(events: MatchEvent[]): void {
    const b = this.ball;
    if (Math.abs(b.y) >= STADIUM.goalHalfWidth || Math.abs(b.x) <= STADIUM.halfWidth) return;
    // Bola no gol da esquerda (de Moscow) é ponto do Cairo, e vice-versa.
    const team: PlayingTeam = b.x < 0 ? "cairo" : "moscow";
    this.score[team]++;

    const [last, previous] = this.touches;
    const ownGoal = last !== undefined && last.team !== team;
    const name = (t: Touch | undefined) => (t ? (this.players.get(t.id)?.name ?? null) : null);
    const assist = !ownGoal && previous && previous.team === team ? name(previous) : null;
    events.push({
      type: "goal",
      goal: {
        team,
        scorer: name(last),
        assist,
        ownGoal,
        tick: this.tick,
        score: { ...this.score },
      },
    });

    this.phase = "goal";
    this.phaseTicksLeft = TIMING.goalCelebrationTicks;
    this.nextKickoff = other(team);

    const { scoreLimit } = this.settings;
    if (this.overtime || (scoreLimit > 0 && this.score[team] >= scoreLimit)) {
      this.result = this.makeResult();
    }
  }

  private checkTime(events: MatchEvent[]): void {
    if (this.overtime || this.phase !== "playing") return;
    if (this.elapsed < this.settings.timeLimitMin * 60 * TICK_RATE) return;
    if (this.score.moscow === this.score.cairo) {
      this.overtime = true;
    } else {
      this.result = this.makeResult();
      this.end(events);
    }
  }

  private end(events: MatchEvent[]): void {
    this.phase = "ended";
    this.phaseTicksLeft = TIMING.endedTicks;
    this.kickoffTeam = null;
    events.push({ type: "ended", result: this.result! });
  }

  private makeResult(): MatchResult {
    const { moscow, cairo } = this.score;
    return {
      score: { ...this.score },
      winner: moscow === cairo ? null : moscow > cairo ? "moscow" : "cairo",
    };
  }
}

/** Formação inicial: colunas de até 3 jogadores no próprio campo. */
export function spawnPosition(team: PlayingTeam, index: number): { x: number; y: number } {
  const side = TEAMS[team].side;
  const column = Math.floor(index / 3);
  const row = index % 3;
  const rowY = [0, -110, 110][row]!;
  return { x: side * (180 + column * 140), y: rowY };
}
