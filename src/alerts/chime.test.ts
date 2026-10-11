import { DEFAULT_SOUND, SOUND_KEY, isSoundBlocked, playChime, readSoundSettings, resetChimeForTests, storeSoundSettings, unlockOnFirstGesture } from './chime';

class FakeAudioContext {
  static made = 0;
  currentTime = 0;
  destination = {};
  resume = vi.fn(() => Promise.resolve());
  constructor() {
    FakeAudioContext.made++;
  }
  createOscillator() {
    const node = { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn((n: unknown) => n), start: vi.fn(), stop: vi.fn() };
    return node;
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn((n: unknown) => n) };
  }
}

beforeEach(() => {
  resetChimeForTests();
  localStorage.clear();
  FakeAudioContext.made = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);
});
afterEach(() => vi.unstubAllGlobals());

describe('chime', () => {
  it('is blocked until the first pointer or key press, then plays', () => {
    expect(isSoundBlocked()).toBe(true);
    expect(playChime(DEFAULT_SOUND)).toBe(false);
    const target = new EventTarget();
    const onUnlock = vi.fn();
    unlockOnFirstGesture(target, onUnlock);
    target.dispatchEvent(new Event('keydown'));
    expect(onUnlock).toHaveBeenCalled();
    expect(isSoundBlocked()).toBe(false);
    expect(playChime(DEFAULT_SOUND)).toBe(true);
  });

  it('does not play when sound is off or the volume is 0', () => {
    const target = new EventTarget();
    unlockOnFirstGesture(target);
    target.dispatchEvent(new Event('pointerdown'));
    expect(playChime({ on: false, volume: 1 })).toBe(false);
    expect(playChime({ on: true, volume: 0 })).toBe(false);
  });

  it('keeps the setting in localStorage, and ignores bad values', () => {
    expect(readSoundSettings()).toEqual(DEFAULT_SOUND);
    storeSoundSettings({ on: false, volume: 0.3 });
    expect(readSoundSettings()).toEqual({ on: false, volume: 0.3 });
    localStorage.setItem(SOUND_KEY, '{"on":"x","volume":7}');
    expect(readSoundSettings()).toEqual(DEFAULT_SOUND);
    localStorage.setItem(SOUND_KEY, 'not json');
    expect(readSoundSettings()).toEqual(DEFAULT_SOUND);
  });
});
