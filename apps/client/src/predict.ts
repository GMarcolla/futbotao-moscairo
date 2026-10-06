import {
  type ControlledPlayer,
  type Disc,
  Input,
  type MatchPhase,
  PlayerFlag,
  type PlayerSnap,
  type PlayingTeam,
  type Snapshot,
  TICK_MS,
  applyControls,
  applyKick,
  applyKickoffLimits,
  collideBallWithStadium,
  collideDiscs,
  collidePlayerWithStadium,
  createBall,
  createPlayer,
  integrate,
  pressInput,
} from "@futbotao/shared";
import type { PlayerPose } from "./timeline";

interface BodyState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Estado do próprio jogador e da bola depois de cada tick local. */
interface TickRecord {
  input: number;
  simulated: boolean;
  me: BodyState & { dashCooldown: number; dashTicks: number };
  ball: BodyState;
}

const HISTORY_TICKS = 240;
const MAX_STEPS_PER_FRAME = 10;
/** Correções maiores que isso (ex.: reposicionamento após gol) são aplicadas na hora. */
const SNAP_DISTANCE = 80;
/** Quanto do erro de posição sobra a cada tick (suaviza as correções). */
const SMOOTHING = 0.85;
const POS_TOLERANCE = 0.5;
const VEL_TOLERANCE = 0.05;

const isSimulated = (phase: MatchPhase) => phase === "playing" || phase === "goal";
const body = (d: Disc): BodyState => ({ x: d.x, y: d.y, vx: d.vx, vy: d.vy });
const setBody = (d: Disc, s: BodyState) => {
  d.x = s.x;
  d.y = s.y;
  d.vx = s.vx;
  d.vy = s.vy;
};
const differs = (a: BodyState, b: BodyState) =>
  Math.hypot(a.x - b.x, a.y - b.y) > POS_TOLERANCE ||
  Math.abs(a.vx - b.vx) + Math.abs(a.vy - b.vy) > VEL_TOLERANCE;

/** Desenho suave de um corpo previsto: interpola entre ticks e esconde correções. */
class Smoothed {
  prev = { x: 0, y: 0 };
  offset = { x: 0, y: 0 };

  reset(d: Disc) {
    this.prev = { x: d.x, y: d.y };
    this.offset = { x: 0, y: 0 };
  }

  /** Guarda o quanto a posição "pulou" para escorregar até a nova. */
  addCorrection(before: { x: number; y: number }, after: Disc) {
    this.offset.x += before.x - after.x;
    this.offset.y += before.y - after.y;
    if (Math.hypot(this.offset.x, this.offset.y) > SNAP_DISTANCE) this.offset = { x: 0, y: 0 };
  }

  decay() {
    this.offset.x *= SMOOTHING;
    this.offset.y *= SMOOTHING;
  }

  render(d: Disc, t: number) {
    return {
      x: this.prev.x + (d.x - this.prev.x) * t + this.offset.x,
      y: this.prev.y + (d.y - this.prev.y) * t + this.offset.y,
    };
  }
}

/**
 * Predição do próprio jogador e da bola: movimento, condução e chute
 * acontecem na hora no navegador, com a mesma física do servidor. Quando o
 * servidor responde, o estado dele vira a base e os comandos ainda não
 * confirmados são reaplicados por cima.
 *
 * Os outros jogadores não são previstos (aparecem com o atraso da rede).
 */
export class Predictor {
  private me: ControlledPlayer | null = null;
  private readonly ball = createBall();
  private readonly meSmooth = new Smoothed();
  private readonly ballSmooth = new Smoothed();
  private tick = 0;
  private accumulator = 0;
  private lastTime: number | null = null;
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
    if (this.seqTick.size > 500) this.seqTick.delete(this.seqTick.keys().next().value!);
    return this.seq;
  }

  reset() {
    this.me = null;
    this.history.clear();
    this.lastTime = null;
  }

  /** Tamanho da correção visual pendente do jogador (usado nos testes). */
  get correction(): number {
    return Math.hypot(this.meSmooth.offset.x, this.meSmooth.offset.y);
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

  /** Recebe um snapshot do servidor com o estado oficial. */
  onServerState(snap: Snapshot, mine: PlayerSnap, team: PlayingTeam, cooldownTicks: number) {
    const [, x, y, flags, dashCooldown, vx, vy, ackSeq, ackSteps] = mine;
    this.phase = snap.ph;
    this.kickoff = snap.ko;
    this.cooldownTicks = cooldownTicks;
    this.serverKickArmed = (flags & PlayerFlag.kickArmed) !== 0;
    this.serverAck = ackSeq;

    const serverMe = { x, y, vx, vy };
    const serverBall = { x: snap.b[0], y: snap.b[1], vx: snap.b[2], vy: snap.b[3] };

    if (!this.me || this.me.team !== team) {
      this.me = createPlayer(team, x, y);
      this.me.input = this.nextInput;
      this.acceptServer(serverMe, serverBall, dashCooldown);
      return;
    }

    const firstTick = ackSeq > 0 ? this.seqTick.get(ackSeq) : undefined;
    if (firstTick === undefined) {
      // Sem como alinhar os tempos: só aceita o servidor se não há comando no caminho.
      if (ackSeq === this.seq) this.acceptServer(serverMe, serverBall, dashCooldown);
      return;
    }
    const at = firstTick + ackSteps - 1;
    const record = this.history.get(at);
    if (at > this.tick || !record) {
      this.acceptServer(serverMe, serverBall, dashCooldown);
      return;
    }

    if (
      !differs(record.me, serverMe) &&
      !differs(record.ball, serverBall) &&
      record.me.dashCooldown === dashCooldown
    ) {
      return;
    }

    // Previsão errou (trombada, alguém tocou na bola...): refaz a partir do oficial.
    const me = this.me;
    const meBefore = { x: me.x, y: me.y };
    const ballBefore = { x: this.ball.x, y: this.ball.y };
    setBody(me, serverMe);
    setBody(this.ball, serverBall);
    me.dashCooldown = dashCooldown;
    me.dashTicks = record.me.dashTicks;
    me.input = record.input;
    me.kickConsumed = (record.input & Input.kick) !== 0 && !this.serverKickArmed;
    me.dashQueued = false;
    me.kickQueued = false;
    this.record(at, record.input, record.simulated);
    for (let t = at + 1; t <= this.tick; t++) {
      const rec = this.history.get(t);
      if (!rec) break;
      this.simulate(rec.input, rec.simulated);
      this.record(t, rec.input, rec.simulated);
    }
    this.meSmooth.addCorrection(meBefore, me);
    this.ballSmooth.addCorrection(ballBefore, this.ball);
  }

  /** Pose do próprio jogador para desenhar agora, ou null se não está jogando. */
  pose(): PlayerPose | null {
    const me = this.me;
    if (!me) return null;
    let flags = 0;
    // Enquanto o servidor não viu o aperto, confia no teclado; depois, no servidor.
    if (me.input & Input.kick && (this.serverAck < this.seq || this.serverKickArmed)) {
      flags |= PlayerFlag.kickArmed;
    }
    if (me.dashTicks > 0) flags |= PlayerFlag.dashing;
    return { ...this.meSmooth.render(me, this.frac()), flags, cooldown: me.dashCooldown };
  }

  /** Posição prevista da bola para desenhar agora. */
  ballPose(): { x: number; y: number } | null {
    return this.me ? this.ballSmooth.render(this.ball, this.frac()) : null;
  }

  /** Posição do jogador alguns ticks atrás (rastro do dash). */
  poseAgo(ticks: number): { x: number; y: number } | null {
    const rec = this.history.get(this.tick - ticks);
    if (!rec) return null;
    const { offset } = this.meSmooth;
    return { x: rec.me.x + offset.x, y: rec.me.y + offset.y };
  }

  private frac(): number {
    return Math.min(1, this.accumulator / TICK_MS);
  }

  private step() {
    this.tick++;
    const simulated = isSimulated(this.phase);
    this.meSmooth.prev = { x: this.me!.x, y: this.me!.y };
    this.ballSmooth.prev = { x: this.ball.x, y: this.ball.y };
    this.simulate(this.nextInput, simulated);
    this.record(this.tick, this.nextInput, simulated);
    this.history.delete(this.tick - HISTORY_TICKS);
    this.meSmooth.decay();
    this.ballSmooth.decay();
  }

  /** Um tick da física na mesma ordem do servidor, só com o próprio jogador e a bola. */
  private simulate(input: number, simulated: boolean) {
    const p = this.me!;
    const ball = this.ball;
    if (input !== p.input) pressInput(p, input);
    // Durante replay/fim de jogo o servidor congela tudo; aqui também.
    if (!simulated) return;
    applyControls(p, this.cooldownTicks);
    applyKick(p, ball);
    integrate(ball);
    integrate(p);
    collideDiscs(p, ball);
    collideBallWithStadium(ball);
    collidePlayerWithStadium(p);
    if (this.kickoff && this.phase === "playing") {
      if (ball.vx !== 0 || ball.vy !== 0) this.kickoff = null;
      else applyKickoffLimits(p, this.kickoff);
    }
  }

  private record(tick: number, input: number, simulated: boolean) {
    const p = this.me!;
    this.history.set(tick, {
      input,
      simulated,
      me: { ...body(p), dashCooldown: p.dashCooldown, dashTicks: p.dashTicks },
      ball: body(this.ball),
    });
  }

  /** Aceita a posição do servidor sem reaplicar comandos (sem como alinhar os tempos). */
  private acceptServer(me: BodyState, ball: BodyState, dashCooldown: number) {
    const p = this.me!;
    setBody(p, me);
    setBody(this.ball, ball);
    p.dashCooldown = dashCooldown;
    p.dashQueued = false;
    p.kickQueued = false;
    this.meSmooth.reset(p);
    this.ballSmooth.reset(this.ball);
    this.record(this.tick, p.input, isSimulated(this.phase));
  }
}
