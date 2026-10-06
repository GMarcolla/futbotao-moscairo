import { type GoalInfo, REPLAY, type Snapshot, TICK_MS } from "@futbotao/shared";

export interface PlayerPose {
  x: number;
  y: number;
  flags: number;
  /** Recarga do dash: 0 = pronto, 1 = acabou de usar. */
  cooldown: number;
}

export interface Frame {
  /** Tick (fracionário) representado. */
  tick: number;
  ball: { x: number; y: number };
  players: Map<number, PlayerPose>;
  /** Snapshot mais recente usado na interpolação (fase, tempo, placar...). */
  snap: Snapshot;
}

/** Atraso de renderização para sempre ter dois snapshots para interpolar. */
const INTERP_DELAY_TICKS = 3.5;
const MAX_FRAMES = 600;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Interpola entre snapshots guardados para um tick qualquer. */
export function sampleFrames(frames: readonly Snapshot[], tick: number): Frame | null {
  if (frames.length === 0) return null;
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  if (tick <= first.k) return toFrame(first, first, 0, first.k);
  if (tick >= last.k) return toFrame(last, last, 0, last.k);
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.k <= tick) lo = mid;
    else hi = mid;
  }
  const a = frames[lo]!;
  const b = frames[hi]!;
  return toFrame(a, b, (tick - a.k) / (b.k - a.k), tick);
}

function toFrame(a: Snapshot, b: Snapshot, t: number, tick: number): Frame {
  const before = new Map(a.p.map((p) => [p[0], p]));
  const players = new Map<number, PlayerPose>();
  for (const pb of b.p) {
    const pa = before.get(pb[0]) ?? pb;
    players.set(pb[0], {
      x: lerp(pa[1], pb[1], t),
      y: lerp(pa[2], pb[2], t),
      flags: pb[3],
      cooldown: pb[4],
    });
  }
  return {
    tick,
    ball: { x: lerp(a.b[0], b.b[0], t), y: lerp(a.b[1], b.b[1], t) },
    players,
    snap: b,
  };
}

/** Guarda os snapshots recebidos e estima o "relógio" do servidor. */
export class Timeline {
  private frames: Snapshot[] = [];
  /** Hora local (ms) em que o tick 0 teria chegado. */
  private offset: number | null = null;

  push(snap: Snapshot, now: number) {
    const last = this.frames[this.frames.length - 1];
    // Partida nova: o tick volta a zero.
    if (last && snap.k <= last.k) this.reset();
    this.frames.push(snap);
    if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);

    const candidate = now - snap.k * TICK_MS;
    if (this.offset === null || candidate < this.offset) this.offset = candidate;
    else this.offset += (candidate - this.offset) * 0.02;
  }

  reset() {
    this.frames = [];
    this.offset = null;
  }

  get latest(): Snapshot | undefined {
    return this.frames[this.frames.length - 1];
  }

  /** Tick que deve ser desenhado agora no jogo ao vivo. */
  renderTick(now: number): number | null {
    if (this.offset === null) return null;
    return (now - this.offset) / TICK_MS - INTERP_DELAY_TICKS;
  }

  sample(tick: number): Frame | null {
    return sampleFrames(this.frames, tick);
  }

  /** Copia os snapshots da janela do replay de um gol. */
  extractReplay(goal: GoalInfo): Snapshot[] {
    const from = goal.tick + REPLAY.startOffsetTicks;
    const to = goal.tick + REPLAY.endOffsetTicks;
    return this.frames.filter((f) => f.k >= from && f.k <= to);
  }
}

/** Toca o replay do gol: trecho normal seguido de câmera lenta. */
export class ReplayPlayer {
  private readonly startedAt: number;
  readonly goal: GoalInfo;
  private readonly frames: Snapshot[];

  constructor(goal: GoalInfo, frames: Snapshot[], now: number) {
    this.goal = goal;
    this.frames = frames;
    this.startedAt = now;
  }

  get hasFrames(): boolean {
    return this.frames.length > 1;
  }

  /** Tick a desenhar e se está em câmera lenta. */
  position(now: number): { tick: number; slow: boolean } {
    const elapsedTicks = (now - this.startedAt) / TICK_MS;
    const start = this.goal.tick + REPLAY.startOffsetTicks;
    const slowFrom = this.goal.tick + REPLAY.slowFromOffsetTicks;
    const end = this.goal.tick + REPLAY.endOffsetTicks;
    const normalTicks = slowFrom - start;
    if (elapsedTicks < normalTicks) return { tick: start + elapsedTicks, slow: false };
    const tick = slowFrom + (elapsedTicks - normalTicks) * REPLAY.slowFactor;
    return { tick: Math.min(tick, end), slow: true };
  }

  sample(tick: number): Frame | null {
    return sampleFrames(this.frames, tick);
  }
}
