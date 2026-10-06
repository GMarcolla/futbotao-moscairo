import {
  type LobbyState,
  type PlayerInfo,
  type RoomSettings,
  SETTINGS_LIMITS,
  TEAMS,
  type Team,
} from "@futbotao/shared";

export interface PanelActions {
  joinTeam(team: Team): void;
  setReady(ready: boolean): void;
  changeSettings(settings: RoomSettings): void;
  copyInvite(): void;
  close(): void;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const COLUMNS: { team: Team; title: string }[] = [
  { team: "moscow", title: TEAMS.moscow.name },
  { team: "spectator", title: "Arquibancada" },
  { team: "cairo", title: TEAMS.cairo.name },
];

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

export class Panel {
  private state: LobbyState | null = null;
  private myId: string | null = null;
  private room = "";
  private countdownEndsAt = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly actions: PanelActions,
  ) {
    el.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!target || target.hasAttribute("disabled")) return;
      switch (target.dataset.action) {
        case "team":
          actions.joinTeam(target.dataset.team as Team);
          break;
        case "ready":
          actions.setReady(target.dataset.ready === "1");
          break;
        case "copy":
          actions.copyInvite();
          break;
        case "close":
          actions.close();
          break;
      }
    });
    el.addEventListener("change", (e) => {
      const select = e.target as HTMLSelectElement;
      if (!select.dataset.setting || !this.state) return;
      const key = select.dataset.setting;
      actions.changeSettings({
        ...this.state.settings,
        [key]: key === "network" ? select.value : Number(select.value),
      });
    });
  }

  update(state: LobbyState, myId: string | null, room: string) {
    this.state = state;
    this.myId = myId;
    this.room = room;
    if (state.countdownMs !== null) this.countdownEndsAt = performance.now() + state.countdownMs;
    this.render();
  }

  /** Atualiza só o número da contagem regressiva (chamado a cada quadro). */
  tick() {
    const el = this.el.querySelector<HTMLElement>("[data-countdown]");
    if (!el) return;
    const s = Math.max(1, Math.ceil((this.countdownEndsAt - performance.now()) / 1000));
    el.textContent = String(s);
  }

  private render() {
    const state = this.state;
    if (!state) return;
    const me = state.players.find((p) => p.id === this.myId);
    const isHost = state.hostId === this.myId;
    const inMatch = state.phase === "match";

    const columns = COLUMNS.map(({ team, title }) => {
      const list = state.players.filter((p) => p.team === team);
      const isMine = me?.team === team;
      const label = team === "spectator" ? "Assistir" : `Entrar no ${title}`;
      return `
        <div class="column ${team}">
          <h3>${title} <span class="count">${list.length}</span></h3>
          <ul>${list.map((p) => this.playerItem(p, state)).join("") || '<li class="empty">ninguém ainda</li>'}</ul>
          <button data-action="team" data-team="${team}" ${isMine ? "disabled" : ""}>
            ${isMine ? "Você está aqui" : label}
          </button>
        </div>`;
    }).join("");

    let status = "";
    if (state.phase === "countdown") {
      status = `<div class="status countdown">Começando em <b data-countdown>3</b>…</div>`;
    } else if (inMatch) {
      const host = state.players.find((p) => p.id === state.matchHostId);
      const where = host ? ` Hospedada no navegador de <b>${escapeHtml(host.name)}</b>.` : "";
      status = `<div class="status">Partida em andamento — escolha um time para entrar no jogo.${where}</div>`;
    } else if (state.lastResult) {
      const { score, winner } = state.lastResult;
      const text = winner ? `${TEAMS[winner].name} venceu!` : "Empate!";
      status = `<div class="status result">Última partida: <b>${text}</b> Moscow ${score.moscow} × ${score.cairo} Cairo</div>`;
    }

    let actions = "";
    if (!inMatch && me && me.team !== "spectator") {
      actions = me.ready
        ? `<button class="primary ready on" data-action="ready" data-ready="0">✔ Pronto — clique para cancelar</button>`
        : `<button class="primary ready" data-action="ready" data-ready="1">Estou pronto!</button>`;
    } else if (!inMatch) {
      actions = `<p class="muted">Escolha Moscow ou Cairo para jogar. A partida começa quando todos nos times estiverem prontos.</p>`;
    } else {
      actions = `<button data-action="close">Voltar ao jogo (Esc)</button>`;
    }

    const s = state.settings;
    const select = (key: keyof RoomSettings, values: number[], fmt: (v: number) => string) => `
      <select data-setting="${key}" ${isHost && !inMatch ? "" : "disabled"}>
        ${values.map((v) => `<option value="${v}" ${v === s[key] ? "selected" : ""}>${fmt(v)}</option>`).join("")}
      </select>`;
    const lim = SETTINGS_LIMITS;
    const networkSelect = `
      <select data-setting="network" ${isHost && !inMatch ? "" : "disabled"}>
        <option value="p2p" ${s.network === "p2p" ? "selected" : ""}>P2P (recomendado)</option>
        <option value="server" ${s.network === "server" ? "selected" : ""}>Servidor (reserva)</option>
      </select>`;

    this.el.innerHTML = `
      <div class="card wide">
        <div class="panel-head">
          <h1>Futbotão <span>Moscairo</span></h1>
          <div class="room">Sala <b>${escapeHtml(this.room)}</b>
            <button data-action="copy" class="small">Copiar convite</button>
          </div>
        </div>
        ${status}
        <div class="columns">${columns}</div>
        <div class="actions">${actions}</div>
        <div class="settings">
          <label>Tempo ${select("timeLimitMin", range(lim.timeLimitMin.min, lim.timeLimitMin.max), (v) => `${v} min`)}</label>
          <label>Gols para vencer ${select("scoreLimit", range(lim.scoreLimit.min, lim.scoreLimit.max), (v) => (v === 0 ? "sem limite" : String(v)))}</label>
          <label title="P2P: a partida roda no navegador de quem criou a sala (menos atraso). Servidor: roda na Cloudflare, para redes que bloqueiam P2P.">Rede ${networkSelect}</label>
          <label>Recarga do dash ${select("dashCooldownSec", range(lim.dashCooldownSec.min, lim.dashCooldownSec.max), (v) => `${v}s`)}</label>
          <span class="muted small">${isHost ? "Você criou a sala e pode ajustar as regras." : "Só quem criou a sala ajusta as regras."}</span>
        </div>
      </div>`;
    this.tick();
  }

  private playerItem(p: PlayerInfo, state: LobbyState): string {
    const tags = [
      p.id === state.hostId ? '<span title="Criou a sala">★</span>' : "",
      p.ready && state.phase !== "match" && p.team !== "spectator" ? '<span class="ok" title="Pronto">✔</span>' : "",
    ].join("");
    const mine = p.id === this.myId ? " me" : "";
    return `<li class="player${mine}"><span class="num">${p.num}</span>${escapeHtml(p.name)} ${tags}</li>`;
  }
}
