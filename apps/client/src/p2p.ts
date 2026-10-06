import type { GuestMessage, HostMessage, IceServer, SignalData } from "@futbotao/shared";

/**
 * Conexões WebRTC do modo P2P, em estrela: cada navegador conecta só no host.
 * Dois canais por conexão:
 * - "rel": confiável e ordenado (comandos, eventos, ping);
 * - "snap": sem retransmissão e sem ordem (snapshots: perder um é melhor que atrasar).
 */

type SendSignal = (to: string, data: SignalData) => void;

/** Snapshot velho na fila não serve para nada: acima disso, pula o envio. */
const MAX_BUFFERED_BYTES = 64 * 1024;

function rtcConfig(ice: IceServer[]): RTCConfiguration {
  return { iceServers: ice as RTCIceServer[] };
}

/** Guarda candidatos que chegam antes da descrição remota. */
class CandidateQueue {
  private pending: RTCIceCandidateInit[] = [];
  private ready = false;

  constructor(private readonly pc: RTCPeerConnection) {}

  add(c: RTCIceCandidateInit) {
    if (this.ready) void this.pc.addIceCandidate(c).catch(() => {});
    else this.pending.push(c);
  }

  flush() {
    this.ready = true;
    for (const c of this.pending) void this.pc.addIceCandidate(c).catch(() => {});
    this.pending = [];
  }
}

function forwardCandidates(pc: RTCPeerConnection, send: (data: SignalData) => void) {
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const { candidate, sdpMid, sdpMLineIndex } = e.candidate;
    send({ candidate: { candidate, sdpMid, sdpMLineIndex } });
  };
}

function parse<T>(data: unknown): T | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export type LinkState = "connecting" | "open" | "failed";

/** Lado de quem joga conectado ao host. */
export class GuestLink {
  private readonly pc: RTCPeerConnection;
  private readonly rel: RTCDataChannel;
  private readonly snap: RTCDataChannel;
  private readonly candidates: CandidateQueue;
  private closed = false;
  state: LinkState = "connecting";

  constructor(
    private readonly hostId: string,
    ice: IceServer[],
    private readonly sendSignal: SendSignal,
    private readonly onMessage: (msg: HostMessage) => void,
    private readonly onState: (state: LinkState) => void,
  ) {
    this.pc = new RTCPeerConnection(rtcConfig(ice));
    this.candidates = new CandidateQueue(this.pc);
    this.rel = this.pc.createDataChannel("rel");
    this.snap = this.pc.createDataChannel("snap", { ordered: false, maxRetransmits: 0 });
    for (const ch of [this.rel, this.snap]) {
      ch.onmessage = (e) => {
        const msg = parse<HostMessage>(e.data);
        if (msg) this.onMessage(msg);
      };
    }
    this.rel.onopen = () => this.setState("open");
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "failed") this.setState("failed");
    };
    forwardCandidates(this.pc, (data) => this.sendSignal(this.hostId, data));
    void this.offer();
  }

  private async offer() {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal(this.hostId, { sdp: { type: "offer", sdp: offer.sdp ?? "" } });
    } catch (err) {
      console.error("Falha ao criar oferta WebRTC", err);
      this.setState("failed");
    }
  }

  async onSignal(data: SignalData) {
    if (this.closed) return;
    if ("sdp" in data && data.sdp.type === "answer") {
      await this.pc.setRemoteDescription(data.sdp);
      this.candidates.flush();
    } else if ("candidate" in data) {
      this.candidates.add(data.candidate);
    }
  }

  send(msg: GuestMessage) {
    if (this.rel.readyState === "open") this.rel.send(JSON.stringify(msg));
  }

  close() {
    this.closed = true;
    this.pc.close();
  }

  private setState(state: LinkState) {
    if (this.state === state || this.closed) return;
    this.state = state;
    this.onState(state);
  }
}

interface Peer {
  pc: RTCPeerConnection;
  candidates: CandidateQueue;
  rel?: RTCDataChannel;
  snap?: RTCDataChannel;
}

/** Lado do host: aceita a conexão de cada um que entra na partida. */
export class HostHub {
  private readonly peers = new Map<string, Peer>();

  constructor(
    private readonly ice: IceServer[],
    private readonly sendSignal: SendSignal,
    private readonly onMessage: (from: string, msg: GuestMessage) => void,
  ) {}

  async onSignal(from: string, data: SignalData) {
    if ("sdp" in data && data.sdp.type === "offer") {
      // Oferta nova (ex.: reconexão): descarta a conexão antiga desse jogador.
      this.peers.get(from)?.pc.close();
      const peer = this.createPeer(from);
      try {
        await peer.pc.setRemoteDescription(data.sdp);
        peer.candidates.flush();
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.sendSignal(from, { sdp: { type: "answer", sdp: answer.sdp ?? "" } });
      } catch (err) {
        console.error("Falha ao responder oferta WebRTC", err);
      }
    } else if ("candidate" in data) {
      this.peers.get(from)?.candidates.add(data.candidate);
    }
  }

  /** Manda para todos pelo canal rápido (snapshots). */
  broadcastSnap(json: string) {
    for (const peer of this.peers.values()) {
      const ch = peer.snap;
      if (ch?.readyState === "open" && ch.bufferedAmount < MAX_BUFFERED_BYTES) ch.send(json);
    }
  }

  /** Manda para todos pelo canal confiável (eventos). */
  broadcastReliable(msg: HostMessage) {
    const json = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.rel?.readyState === "open") peer.rel.send(json);
    }
  }

  sendTo(id: string, msg: HostMessage) {
    const ch = this.peers.get(id)?.rel;
    if (ch?.readyState === "open") ch.send(JSON.stringify(msg));
  }

  close() {
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection(rtcConfig(this.ice));
    const peer: Peer = { pc, candidates: new CandidateQueue(pc) };
    this.peers.set(id, peer);
    forwardCandidates(pc, (data) => this.sendSignal(id, data));
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === "rel") peer.rel = ch;
      else if (ch.label === "snap") peer.snap = ch;
      ch.onmessage = (ev) => {
        const msg = parse<GuestMessage>(ev.data);
        if (msg) this.onMessage(id, msg);
      };
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (this.peers.get(id)?.pc === pc) this.peers.delete(id);
      }
    };
    return peer;
  }
}
