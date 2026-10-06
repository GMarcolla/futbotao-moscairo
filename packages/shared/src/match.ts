import { PHYSICS, STADIUM, TEAMS, TICK_RATE, TIMING } from "./constants";
import { type Disc, collideDiscs, integrate } from "./physics";
import {
  type ControlledPlayer,
  applyControls,
  applyKick,
  collideBallWithStadium,
  createBall,
  applyKickoffLimits,
  collidePlayerWithStadium,
  createPlayer,
  pressInput,
} from "./player";
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

export interface MatchPlayer extends ControlledPlayer {
  id: string;
  num: number;
  name: string;
  /** Último comando recebido do cliente (para a predição dele). */
  ackSeq: number;
  /** Tick em que esse comando passou a valer. */
  ackTick: number;
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
// Precisão suficiente para a predição do cliente bater com o servidor.
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

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
    this.ball = createBall();
  }

  addPlayer(id: string, num: number, name: string, team: PlayingTeam): void {
    const index = this.teamPlayers(team).length;
    const spawn = spawnPosition(team, index);
    this.players.set(id, {
      ...createPlayer(team, spawn.x, spawn.y),
      id,
      num,
      name,
      ackSeq: 0,
      ackTick: this.tick + 1,
    });
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  teamPlayers(team: PlayingTeam): MatchPlayer[] {
    return [...this.players.values()].filter((p) => p.team === team);
  }

  /** `seq` numera os comandos do cliente; vale a partir do próximo tick. */
  setInput(id: string, input: number, seq = 0): void {
    const p = this.players.get(id);
    if (!p) return;
    pressInput(p, input);
    if (seq > p.ackSeq) {
      p.ackSeq = seq;
      p.ackTick = this.tick + 1;
    }
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
    const p: PlayerSnap[] = [];
    for (const pl of this.players.values()) {
      let flags = 0;
      if (pl.input & Input.kick && !pl.kickConsumed) flags |= PlayerFlag.kickArmed;
      if (pl.dashTicks > 0) flags |= PlayerFlag.dashing;
      p.push([
        pl.num,
        round2(pl.x),
        round2(pl.y),
        flags,
        pl.dashCooldown,
        round3(pl.vx),
        round3(pl.vy),
        pl.ackSeq,
        pl.ackSeq ? this.tick - pl.ackTick + 1 : 0,
      ]);
    }
    return {
      k: this.tick,
      ph: this.phase,
      t: this.elapsed,
      ot: this.overtime ? 1 : 0,
      ko: this.kickoffTeam,
      b: [round2(this.ball.x), round2(this.ball.y), round3(this.ball.vx), round3(this.ball.vy)],
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
    const cooldownTicks = this.settings.dashCooldownSec * TICK_RATE;

    for (const p of this.players.values()) {
      applyControls(p, cooldownTicks);
      if (applyKick(p, this.ball)) this.touch(p);
    }

    integrate(this.ball);
    for (const p of this.players.values()) integrate(p);

    const players = [...this.players.values()];
    for (let i = 0; i < players.length; i++) {
      const a = players[i]!;
      for (let j = i + 1; j < players.length; j++) collideDiscs(a, players[j]!);
      if (collideDiscs(a, this.ball)) this.touch(a);
    }
    collideBallWithStadium(this.ball);
    for (const p of players) collidePlayerWithStadium(p);

    if (this.kickoffTeam && this.phase === "playing") {
      if (this.ball.vx !== 0 || this.ball.vy !== 0) this.kickoffTeam = null;
      else for (const p of players) applyKickoffLimits(p, this.kickoffTeam);
    }

    if (allowGoals) this.checkGoal(events);
  }

  private touch(p: MatchPlayer): void {
    if (this.touches[0]?.id === p.id) return;
    this.touches.unshift({ id: p.id, team: p.team });
    this.touches.length = Math.min(this.touches.length, 2);
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
