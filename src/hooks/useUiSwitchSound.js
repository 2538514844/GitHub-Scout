import { useCallback, useEffect, useRef, useState } from 'react';
import pageTurnSoundUrl from '../../mixkit-fast-double-click-on-mouse-275.wav';

const STORAGE_KEY = 'github-scout-ui-switch-sound';

function readInitialEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export default function useUiSwitchSound() {
  const audioPoolRef = useRef([]);
  const nextAudioIndexRef = useRef(0);
  const lastPlayedAtRef = useRef(0);
  const [soundEnabled, setSoundEnabled] = useState(readInitialEnabled);

  const ensureAudioPool = useCallback(() => {
    if (typeof Audio === 'undefined') return [];
    if (audioPoolRef.current.length > 0) {
      return audioPoolRef.current;
    }

    audioPoolRef.current = Array.from({ length: 3 }, () => {
      const audio = new Audio(pageTurnSoundUrl);
      audio.preload = 'auto';
      return audio;
    });

    return audioPoolRef.current;
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, soundEnabled ? 'on' : 'off');
    } catch {
      // Ignore storage errors in restricted environments.
    }
  }, [soundEnabled]);

  useEffect(() => () => {
    audioPoolRef.current.forEach((audio) => {
      audio.pause();
      audio.src = '';
    });
  }, []);

  const playSwitchSound = useCallback(async (variant = 'switch') => {
    if (!soundEnabled) return;

    const nowMs = performance.now();
    const minInterval = variant === 'tab' ? 85 : 130;
    if (nowMs - lastPlayedAtRef.current < minInterval) return;
    lastPlayedAtRef.current = nowMs;

    const pool = ensureAudioPool();
    if (pool.length === 0) return;

    const audio = pool[nextAudioIndexRef.current];
    nextAudioIndexRef.current = (nextAudioIndexRef.current + 1) % pool.length;

    try {
      audio.pause();
      audio.currentTime = 0;
      audio.volume = variant === 'toggle' ? 0.16 : 0.18;
      await audio.play();
    } catch {
      // Ignore play failures caused by autoplay restrictions.
    }
  }, [ensureAudioPool, soundEnabled]);

  return {
    soundEnabled,
    setSoundEnabled,
    playSwitchSound,
  };
}
