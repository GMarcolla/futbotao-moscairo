import {
  type ControlledPlayer,
  Input,
  type MatchPhase,
  PlayerFlag,
  type PlayerSnap,
  type PlayingTeam,
  TICK_MS,
  applyControls,
  applyKickoffLimits,
  collidePlayerWithStadium,
  createPlayer,
  integrate,
  pressInput,
} from "@futbotao/shared";
import type { PlayerPose } from "./timeline";

/** Estado do próprio jogador depois de cada tick local. */
interface TickRecord {
  input: number;
  simulated: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dashCooldown: number;
  dashTicks: number;
}

const HISTORY_TICKS = 240;
const MAX_STEPS_PER_FRAME = 10;
/** Correções maiores que isso (ex.: reposicionamento após gol) são aplicadas na hora. */
const SNAP_DISTANCE = 80;
/** Quanto do erro de posição sobra a cada tick (suaviza as correções). */
const SMOOTHING = 0.85;

const isSimulated = (phase: MatchPhase) => phase === "playing" || phase === "goal";

/**
 * Predição do próprio jogador: o movimento acontece na hora no navegador,
 * com a mesma física do servidor. Quando o servidor responde, o estado dele
 * vira a base e os comandos ainda não confirmados são reaplicados por cima.
 */
export class Predictor {
  private me: ControlledPlayer | null = null;
  private tick = 0;
  private accumulator = 0;
  private lastTime: number | null = null;
  private prev = { x: 0, y: 0 };
  private offset = { x: 0, y: 0 };
  private nextInput = 0;
  private seq = 0;
  private readonly seqTick = new Map<number, number>();
  private readonly history = new Map<number, TickRecord>();
  private phase: MatchPhase = "playing";
  private kickoff: PlayingTeam | null = null;
  private cooldownTicks = 600;
  private serverKickArmed = false;
  private serverAck = 0;

  /** Novo estado do teclado. Retorna o número do comando para mandar ao servidor. */
  setInput(bits: number): number {
    this.nextInput = bits;
    this.seq++;
    this.seqTick.set(this.seq, this.tick + 1);
    if (this.seqTick.size > 500) {
      const oldest = this.seqTick.keys().next().value!;
      this.seqTick.delete(oldest);
    }
    return this.seq;
  }

  reset() {
    this.me = null;
    this.history.clear();
    this.offset = { x: 0, y: 0 };
    this.lastTime = null;
  }

  /** Avança a simulação local em passos fixos de 60Hz. */
  update(now: number) {
    if (!this.me) {
      this.lastTime = null;
      return;
    }
    if (this.lastTime === null) this.lastTime = now;
    this.accumulator += now - this.lastTime;
    this.lastTime = now;
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= TICK_MS;
      this.step();
      steps++;
    }
    // Aba ficou em segundo plano: descarta o atraso; o servidor corrige a posição.
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
  }

  /** Recebe o estado oficial do próprio jogador vindo do servidor. */
  onServerState(
    snap: PlayerSnap,
    team: PlayingTeam,
    phase: MatchPhase,
    kickoff: PlayingTeam | null,
    cooldownTicks: number,
  ) {
    const [, x, y, flags, dashCooldown, vx, vy, ackSeq, ackSteps] = snap;
    this.phase = phase;
    this.kickoff = kickoff;
    this.cooldownTicks = cooldownTicks;
    this.serverKickArmed = (flags & PlayerFlag.kickArmed) !== 0;
    this.serverAck = ackSeq;

    const server = { x, y, vx, vy, dashCooldown };
    if (!this.me || this.me.team !== team) {
      this.me = createPlayer(team, x, y);
      this.me.input = this.nextInput;
      this.history.clear();
      this.rebase(server);
      this.resetHistory();
      return;
    }

    const firstTick = ackSeq > 0 ? this.seqTick.get(ackSeq) : undefined;
    if (firstTick === undefined) {
      // Sem como alinhar os tempos: só aceita o servidor se não há comando no caminho.
      if (ackSeq === this.seq) {
        this.rebase(server);
        this.resetHistory();
      }
      return;
    }
    const at = firstTick + ackSteps - 1;
    const record = this.history.get(at);
    if (at > this.tick || !record) {
      this.rebase(server);
      this.resetHistory();
      return;
    }

    const posError = Math.hypot(record.x - x, record.y - y);
    const velError = Math.abs(record.vx - vx) + Math.abs(record.vy - vy);
    if (posError < 0.5 && velError < 0.05 && record.dashCooldown === dashCooldown) return;

    // Previsão errou (ex.: trombada com alguém): refaz a partir do estado oficial.
    const before = { x: this.me.x, y: this.me.y };
    this.rebase({ ...server, dashTicks: record.dashTicks, input: record.input });
    for (let t = at + 1; t <= this.tick; t++) {
      const rec = this.history.get(t);
      if (!rec) break;
      this.simulate(rec.input, rec.simulated);
      this.record(t, rec.input, rec.simulated);
    }
    this.offset.x += before.x - this.me.x;
    this.offset.y += before.y - this.me.y;
    if (Math.hypot(this.offset.x, this.offset.y) > SNAP_DISTANCE) this.offset = { x: 0, y: 0 };
  }

  /** Pose do próprio jogador para desenhar agora, ou null se não está jogando. */
  pose(): PlayerPose | null {
    const me = this.me;
    if (!me) return null;
    const t = Math.min(1, this.accumulator / TICK_MS);
    let flags = 0;
    const holdingKick = (me.input & Input.kick) !== 0;
    // Enquanto o servidor não viu o aperto, confia no teclado; depois, no servidor.
    if (holdingKick && (this.serverAck < this.seq || this.serverKickArmed)) {
      flags |= PlayerFlag.kickArmed;
    }
    if (me.dashTicks > 0) flags |= PlayerFlag.dashing;
    return {
      x: this.prev.x + (me.x - this.prev.x) * t + this.offset.x,
      y: this.prev.y + (me.y - this.prev.y) * t + this.offset.y,
      flags,
      cooldown: me.dashCooldown,
    };
  }

  /** Tamanho da correção visual pendente (usado nos testes). */
  get correction(): number {
    return Math.hypot(this.offset.x, this.offset.y);
  }

  /** Posição de alguns ticks atrás (rastro do dash). */
  poseAgo(ticks: number): { x: number; y: number } | null {
    const rec = this.history.get(this.tick - ticks);
    return rec ? { x: rec.x + this.offset.x, y: rec.y + this.offset.y } : null;
  }

  private step() {
    this.tick++;
    const simulated = isSimulated(this.phase);
    this.prev = { x: this.me!.x, y: this.me!.y };
    this.simulate(this.nextInput, simulated);
    this.record(this.tick, this.nextInput, simulated);
    this.history.delete(this.tick - HISTORY_TICKS);
    this.offset.x *= SMOOTHING;
    this.offset.y *= SMOOTHING;
  }

  private simulate(input: number, simulated: boolean) {
    const p = this.me!;
    if (input !== p.input) pressInput(p, input);
    // Durante replay/fim de jogo o servidor congela os jogadores; aqui também.
    if (!simulated) return;
    applyControls(p, this.cooldownTicks);
    p.kickQueued = false;
    if (!(p.input & Input.kick)) p.kickConsumed = false;
    integrate(p);
    collidePlayerWithStadium(p);
    if (this.kickoff && this.phase === "playing") applyKickoffLimits(p, this.kickoff);
  }

  private record(tick: number, input: number, simulated: boolean) {
    const p = this.me!;
    this.history.set(tick, {
      input,
      simulated,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      dashCooldown: p.dashCooldown,
      dashTicks: p.dashTicks,
    });
  }

  private rebase(s: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    dashCooldown: number;
    dashTicks?: number;
    input?: number;
  }) {
    const p = this.me!;
    p.x = s.x;
    p.y = s.y;
    p.vx = s.vx;
    p.vy = s.vy;
    p.dashCooldown = s.dashCooldown;
    if (s.dashTicks !== undefined) p.dashTicks = s.dashTicks;
    if (s.input !== undefined) p.input = s.input;
    p.dashQueued = false;
    p.kickQueued = false;
  }

  /** Depois de aceitar a posição do servidor sem reaplicar comandos. */
  private resetHistory() {
    const p = this.me!;
    this.prev = { x: p.x, y: p.y };
    this.offset = { x: 0, y: 0 };
    this.record(this.tick, p.input, isSimulated(this.phase));
  }
}
