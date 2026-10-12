/**
 * The alert sound (docs/ALERTS_PLAN.md, section 4.5): a short two-note chime made with the
 * Web Audio API, so no sound file is in the bundle.
 *
 * Browsers block audio until the user interacts with the page. `unlockOnFirstGesture`
 * waits for the first pointer or key press and resumes the audio context then;
 * `isSoundBlocked` tells the popup to show its "Sound is off until you click" note.
 */
export const SOUND_KEY = 'rhinoview:alert-sound';

export interface SoundSettings {
  on: boolean;
  /** 0..1 */
  volume: number;
}

export const DEFAULT_SOUND: SoundSettings = { on: true, volume: 0.5 };

export function readSoundSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(SOUND_KEY);
    if (!raw) return DEFAULT_SOUND;
    const v = JSON.parse(raw) as Partial<SoundSettings>;
    const volume = typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1 ? v.volume : DEFAULT_SOUND.volume;
    return { on: typeof v.on === 'boolean' ? v.on : DEFAULT_SOUND.on, volume };
  } catch {
    return DEFAULT_SOUND;
  }
}

export function storeSoundSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(s));
  } catch {
    // Storage can be full or blocked; the setting then lasts for this page only.
  }
}

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
let unlocked = false;

function audioContextClass(): AudioContextCtor | null {
  const w = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioContextClass();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** True until the first user gesture on the page (or when there is no audio at all). */
export function isSoundBlocked(): boolean {
  return !unlocked;
}

/** Resume audio on the first pointer or key press. Returns a function that removes the listeners. */
export function unlockOnFirstGesture(target: EventTarget = document, onUnlock?: () => void): () => void {
  const unlock = () => {
    const c = context();
    void c?.resume?.().catch(() => undefined);
    unlocked = true;
    remove();
    onUnlock?.();
  };
  const remove = () => {
    target.removeEventListener('pointerdown', unlock);
    target.removeEventListener('keydown', unlock);
  };
  if (unlocked) return () => undefined;
  target.addEventListener('pointerdown', unlock);
  target.addEventListener('keydown', unlock);
  return remove;
}

/** Plays the chime when sound is on and the page is unlocked. Never throws. */
export function playChime(settings: SoundSettings = readSoundSettings()): boolean {
  if (!settings.on || settings.volume <= 0 || !unlocked) return false;
  const c = context();
  if (!c) return false;
  try {
    const start = c.currentTime;
    // Two short notes, E6 then A6, each with a fast attack and an exponential decay.
    [1318.5, 1760].forEach((freq, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const t0 = start + i * 0.12;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25 * settings.volume + 0.0001, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
    return true;
  } catch {
    return false;
  }
}

/** Tests: forget the context and the unlock. */
export function resetChimeForTests(): void {
  ctx = null;
  unlocked = false;
}
