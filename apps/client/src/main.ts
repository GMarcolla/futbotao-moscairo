import "./style.css";
import {
  DEFAULT_ICE_SERVERS,
  type GoalInfo,
  type HostMessage,
  type IceServer,
  type LobbyState,
  type MatchResult,
  type PlayerInfo,
  type ServerMessage,
  type Snapshot,
  TEAMS,
  TICK_RATE,
  type Team,
} from "@futbotao/shared";
import { listenKeyboard } from "./input";
import { connect } from "./net";
import { Panel } from "./panel";
import { Predictor } from "./predict";
import { type ChatBubble, Renderer } from "./render";
import { type MatchSession, createSession } from "./session";
import { playCrowd, playWhistle, unlockAudio } from "./sound";
import { type Frame, ReplayPlayer, Timeline } from "./timeline";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const NAME_KEY = "futbotao:name";
const BUBBLE_MS = 2500;
const TRAIL_TICKS = [3, 6, 9];
/** Quanto a bola desenhada segue a prevista quando você é (ou deixa de ser) o mais perto. */
const BALL_BLEND_SPEED = 0.15;
const BALL_BLEND_MARGIN = 30;

function readRoom(): string {
  const raw = new URLSearchParams(location.search).get("sala") ?? "moscairo";
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return clean || "moscairo";
}

function storedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Sem armazenamento local: só não lembra o apelido.
  }
}

const room = readRoom();
const renderer = new Renderer($<HTMLCanvasElement>("field"));
const timeline = new Timeline();
const predictor = new Predictor();

let myId: string | null = null;
let myName = "";
let ice: IceServer[] = DEFAULT_ICE_SERVERS;
let session: MatchSession | null = null;
/** Durante partida P2P o ping mostrado é o até o host, não o do servidor. */
let sessionPing = false;
/** 1 = bola prevista (você está com ela), 0 = bola do servidor (outro está). */
let ballBlend = 0;
let lobby: LobbyState | null = null;
const playersByNum = new Map<number, PlayerInfo>();
/** Time em que estávamos, para voltar a ele se a conexão cair. */
let lastTeam: Team = "spectator";
let rejoinTeam: Team | null = null;
let panelOpen = false;
let replay: ReplayPlayer | null = null;
let lastGoal: GoalInfo | null = null;
let endedResult: MatchResult | null = null;
let bubbles: ChatBubble[] = [];
let toastTimer = 0;

const net = connect(room, {
  onOpen() {
    $("join-status").textContent = "Conectado.";
    if (myName) {
      rejoinTeam = lastTeam !== "spectator" ? lastTeam : null;
      net.send({ t: "join", name: myName });
    }
  },
  onClose() {
    $("join-status").textContent = "Sem conexão com o servidor, tentando de novo…";
    if (myName) toast("Conexão perdida, reconectando…");
  },
  onMessage: handleMessage,
});

const panel = new Panel($("panel"), {
  joinTeam: (team) => net.send({ t: "team", team }),
  setReady: (ready) => net.send({ t: "ready", ready }),
  changeSettings: (settings) => net.send({ t: "settings", settings }),
  copyInvite() {
    const url = `${location.origin}${location.pathname}?sala=${room}`;
    navigator.clipboard.writeText(url).then(
      () => toast("Convite copiado!"),
      () => toast(url),
    );
  },
  close: () => setPanelOpen(false),
});

const keyboard = listenKeyboard({
  enabled: () => isPlaying() && !panelOpen,
  onChange: (bits) => session?.sendInput(bits, predictor.setInput(bits)),
  onQuickChat: (n) => net.send({ t: "chat", n }),
  onTogglePanel: () => {
    if (lobby?.phase === "match") setPanelOpen(!panelOpen);
  },
});

// ---- Entrada na sala ----

const nickInput = $<HTMLInputElement>("nick");
nickInput.value = storedName();
nickInput.focus();
$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nickInput.value.trim();
  if (!name) return;
  unlockAudio();
  myName = name;
  storeName(name);
  net.send({ t: "join", name });
  $("join").hidden = true;
  $("scoreboard").hidden = false;
  updatePanelVisibility();
});

setInterval(() => {
  if (net.connected) net.send({ t: "ping", c: performance.now() });
}, 5000);

// ---- Mensagens do servidor ----

function handleMessage(msg: ServerMessage) {
  const now = performance.now();
  switch (msg.t) {
    case "welcome":
      myId = msg.id;
      ice = msg.ice?.length ? msg.ice : DEFAULT_ICE_SERVERS;
      break;
    case "lobby":
      onLobby(msg.s);
      break;
    case "snap":
    case "goal":
    case "ended":
      handleMatchMessage(msg);
      break;
    case "signal":
      session?.onSignal(msg.from, msg.data);
      break;
    case "chat":
      bubbles = bubbles.filter((b) => b.num !== msg.num && b.until > now);
      bubbles.push({ num: msg.num, index: msg.n, until: now + BUBBLE_MS });
      break;
    case "pong":
      if (!sessionPing) $("ping").textContent = `ping ${Math.round(now - msg.c)} ms`;
      break;
    case "error":
      toast(msg.message);
      break;
  }
}

/** Snapshots e eventos da partida (do servidor, do host P2P ou do próprio Worker). */
function handleMatchMessage(msg: HostMessage) {
  const now = performance.now();
  switch (msg.t) {
    case "snap":
      if (!timeline.push(msg.s, now)) return;
      onSnapForPrediction(msg.s);
      if (msg.s.ph === "replay") {
        if (!replay && lastGoal) {
          replay = new ReplayPlayer(lastGoal, timeline.extractReplay(lastGoal), now);
        }
      } else {
        replay = null;
      }
      break;
    case "goal":
      lastGoal = msg.g;
      $("score-moscow").textContent = String(msg.g.score.moscow);
      $("score-cairo").textContent = String(msg.g.score.cairo);
      playCrowd();
      break;
    case "ended":
      endedResult = msg.r;
      playWhistle(true);
      break;
  }
}

function startSession(state: LobbyState) {
  if (!myId) return;
  session = createSession(state, {
    myId,
    ice,
    sendServer: (msg) => net.send(msg),
    onMatchMessage: handleMatchMessage,
    onStatus: (text) => setText("net-status", text),
    onPing: (ms, label) => {
      sessionPing = true;
      $("ping").textContent = ms ? `ping ${ms} ms (${label})` : label;
    },
  });
}

function stopSession() {
  session?.close();
  session = null;
  sessionPing = false;
  setText("net-status", null);
}

function onLobby(state: LobbyState) {
  const previous = lobby?.phase;
  lobby = state;
  playersByNum.clear();
  for (const p of state.players) playersByNum.set(p.num, p);

  const me = state.players.find((p) => p.id === myId);
  if (me) {
    if (rejoinTeam && me.team === "spectator") {
      net.send({ t: "team", team: rejoinTeam });
    } else {
      lastTeam = me.team;
    }
    rejoinTeam = null;
  }

  if (state.phase === "match" && previous !== "match") {
    timeline.reset();
    predictor.reset();
    replay = null;
    lastGoal = null;
    endedResult = null;
    setPanelOpen(false);
    playWhistle();
  }
  if (state.phase === "match") {
    if (!session) startSession(state);
    else session.onLobby(state);
  } else {
    if (session) stopSession();
    replay = null;
    endedResult = null;
  }
  $("score-moscow").textContent = String(state.score.moscow);
  $("score-cairo").textContent = String(state.score.cairo);
  panel.update(state, myId, room);
  updatePanelVisibility();
}

// ---- Predição do próprio jogador ----

function myPlayer(): PlayerInfo | undefined {
  return lobby?.players.find((p) => p.id === myId);
}

function dashCooldownTicks(): number {
  return (lobby?.settings.dashCooldownSec ?? 10) * TICK_RATE;
}

function onSnapForPrediction(snap: Snapshot) {
  const me = myPlayer();
  const mine = me && me.team !== "spectator" ? snap.p.find((p) => p[0] === me.num) : undefined;
  if (!me || me.team === "spectator" || !mine) {
    predictor.reset();
    return;
  }
  predictor.onServerState(snap, mine, me.team, dashCooldownTicks());
}

/**
 * Troca o próprio jogador (atrasado) pelo previsto (na hora). A bola prevista
 * só é usada quando você é quem está mais perto dela: se outro jogador está
 * com a bola, ela continua "colada" nele como chegou da rede.
 */
function applyPrediction(frame: Frame, trail: Frame[], myNum: number) {
  const pose = predictor.pose();
  const predictedBall = predictor.ballPose();
  if (!pose || !predictedBall || !frame.players.has(myNum)) return;
  frame.players.set(myNum, pose);

  const myDist = Math.hypot(pose.x - predictedBall.x, pose.y - predictedBall.y);
  let otherDist = Infinity;
  for (const [num, p] of frame.players) {
    if (num !== myNum) otherDist = Math.min(otherDist, Math.hypot(p.x - frame.ball.x, p.y - frame.ball.y));
  }
  const target = Math.min(1, Math.max(0, (otherDist - myDist) / BALL_BLEND_MARGIN + 0.5));
  ballBlend += (target - ballBlend) * BALL_BLEND_SPEED;
  frame.ball = {
    x: frame.ball.x + (predictedBall.x - frame.ball.x) * ballBlend,
    y: frame.ball.y + (predictedBall.y - frame.ball.y) * ballBlend,
  };
  trail.forEach((past, i) => {
    const pos = predictor.poseAgo(TRAIL_TICKS[i]!);
    const old = past.players.get(myNum);
    if (pos && old) past.players.set(myNum, { ...old, ...pos });
  });
}

// ---- Interface ----

function isPlaying(): boolean {
  if (lobby?.phase !== "match") return false;
  const me = lobby.players.find((p) => p.id === myId);
  return !!me && me.team !== "spectator";
}

function setPanelOpen(open: boolean) {
  panelOpen = open;
  if (open) keyboard.releaseAll();
  updatePanelVisibility();
}

function updatePanelVisibility() {
  const joined = $("join").hidden;
  $("panel").hidden = !joined || (lobby?.phase === "match" && !panelOpen);
}

function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3000);
}

function formatClock(ticks: number): string {
  const total = Math.floor(ticks / TICK_RATE);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function goalText(g: GoalInfo): { title: string; detail: string } {
  const title = `GOOOL DO ${TEAMS[g.team].name.toUpperCase()}!`;
  if (g.ownGoal) return { title, detail: `Gol contra de ${g.scorer ?? "alguém"} 🙈` };
  const detail = [g.scorer ? `⚽ ${g.scorer}` : "", g.assist ? `🅰️ ${g.assist}` : ""]
    .filter(Boolean)
    .join("   ");
  return { title, detail };
}

function setBanner(html: string | null, className = "") {
  const el = $("banner");
  if (html === null) {
    el.hidden = true;
    return;
  }
  if (el.innerHTML !== html) el.innerHTML = html;
  el.className = className;
  el.hidden = false;
}

function setText(id: string, text: string | null) {
  const el = $(id);
  el.hidden = text === null;
  if (text !== null && el.textContent !== text) el.textContent = text;
}

function updateHud(frame: Frame | null, slowMotion: boolean | null) {
  const snap = frame?.snap ?? null;
  const inMatch = lobby?.phase === "match";

  if (snap && inMatch) {
    const limit = (lobby?.settings.timeLimitMin ?? 0) * 60 * TICK_RATE;
    $("clock").textContent = formatClock(snap.t);
    $("clock-sub").textContent = snap.ot ? "PRORROGAÇÃO · gol de ouro" : `de ${formatClock(limit)}`;
  } else {
    $("clock").textContent = "00:00";
    $("clock-sub").textContent = inMatch ? "" : "aguardando partida";
  }

  // Durante o replay o tempo desenhado é antigo: usa a fase "real" do servidor.
  const live = timeline.latest;
  const phase = inMatch ? live?.ph : undefined;
  if (phase === "goal" && lastGoal) {
    const { title, detail } = goalText(lastGoal);
    setBanner(`<strong>${title}</strong><span>${escapeText(detail)}</span>`, `goal ${lastGoal.team}`);
  } else if (phase === "ended" && endedResult) {
    const { winner, score } = endedResult;
    const title = winner ? `${TEAMS[winner].name.toUpperCase()} VENCEU!` : "EMPATE!";
    setBanner(
      `<strong>FIM DE JOGO</strong><span>${title} Moscow ${score.moscow} × ${score.cairo} Cairo</span>`,
      `ended ${winner ?? ""}`,
    );
  } else {
    setBanner(null);
  }

  if (slowMotion !== null && lastGoal) {
    const who = lastGoal.ownGoal ? "gol contra" : (lastGoal.scorer ?? "");
    setText("replay-tag", `▶ REPLAY${slowMotion ? " · câmera lenta" : ""}${who ? ` — ${who}` : ""}`);
  } else {
    setText("replay-tag", null);
  }

  let hint: string | null = null;
  if (inMatch && phase === "playing" && live?.ko) hint = `Saída de bola: ${TEAMS[live.ko].name}`;
  else if (inMatch && !isPlaying() && !panelOpen) hint = "Você está na arquibancada — aperte Esc para entrar em um time";
  setText("hint", hint);
}

function escapeText(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---- Loop de desenho ----

function frameLoop() {
  const now = performance.now();
  predictor.update(now);
  let frame: Frame | null = null;
  let trail: Frame[] = [];
  let slowMotion: boolean | null = null;

  if (lobby?.phase === "match") {
    if (replay?.hasFrames) {
      const pos = replay.position(now);
      frame = replay.sample(pos.tick);
      trail = TRAIL_TICKS.map((d) => replay!.sample(pos.tick - d)).filter((f) => f !== null);
      slowMotion = pos.slow;
    } else {
      const tick = timeline.renderTick(now);
      if (tick !== null) {
        frame = timeline.sample(tick);
        trail = TRAIL_TICKS.map((d) => timeline.sample(tick - d)).filter((f) => f !== null);
      }
    }
  }

  const myNum = myPlayer()?.num ?? null;
  if (frame && slowMotion === null && myNum !== null) applyPrediction(frame, trail, myNum);
  renderer.draw(
    frame
      ? { frame, trail, players: playersByNum, myNum, dashCooldownTicks: dashCooldownTicks(), bubbles, now }
      : null,
    frame && slowMotion === null ? frame.snap.ko : null,
  );
  updateHud(frame, slowMotion);
  panel.tick();
  requestAnimationFrame(frameLoop);
}

requestAnimationFrame(frameLoop);
