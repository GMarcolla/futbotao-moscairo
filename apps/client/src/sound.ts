let audio: AudioContext | null = null;

/** Precisa ser chamado num clique do usuário (regra dos navegadores). */
export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = null;
  }
}

/** Barulho de torcida gerado na hora (ruído filtrado), sem arquivos de áudio. */
export function playCrowd() {
  if (!audio) return;
  const duration = 2.2;
  const buffer = audio.createBuffer(1, audio.sampleRate * duration, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  const filter = audio.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 900;
  filter.Q.value = 0.6;
  const gain = audio.createGain();
  const t = audio.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.35, t + 0.15);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  source.connect(filter).connect(gain).connect(audio.destination);
  source.start();
}

/** Apito curto (início e fim de jogo). */
export function playWhistle(long = false) {
  if (!audio) return;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(2300, t);
  const lfo = audio.createOscillator();
  lfo.frequency.value = 30;
  const lfoGain = audio.createGain();
  lfoGain.gain.value = 120;
  lfo.connect(lfoGain).connect(osc.frequency);
  const gain = audio.createGain();
  const len = long ? 0.9 : 0.35;
  gain.gain.setValueAtTime(0.06, t);
  gain.gain.setValueAtTime(0.06, t + len - 0.05);
  gain.gain.linearRampToValueAtTime(0, t + len);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  lfo.start(t);
  osc.stop(t + len);
  lfo.stop(t + len);
}
