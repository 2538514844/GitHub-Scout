import React, { useEffect, useMemo, useRef, useState } from 'react';

function PresentationPlayerOverlay({ session, onClose }) {
  const items = session?.items || [];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [pageReady, setPageReady] = useState(false);
  const [status, setStatus] = useState('idle');
  const [completed, setCompleted] = useState(false);

  const audioRef = useRef(null);
  const pageTimeoutRef = useRef(null);
  const readyDelayRef = useRef(null);
  const advanceTimeoutRef = useRef(null);
  const pageTokenRef = useRef(0);

  const currentItem = items[currentIndex] || null;
  const progressValue = items.length > 0 ? ((currentIndex + 1) / items.length) * 100 : 0;

  const statusText = useMemo(() => {
    if (completed) return '播放完成';
    if (status === 'loading-page') return '网页载入中';
    if (status === 'ready-delay') return '页面稳定中';
    if (status === 'playing') return '语音播放中';
    if (status === 'error') return '播放失败';
    return '等待开始';
  }, [completed, status]);

  const clearPlayback = () => {
    clearTimeout(pageTimeoutRef.current);
    clearTimeout(readyDelayRef.current);
    clearTimeout(advanceTimeoutRef.current);

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearPlayback();
    };
  }, []);

  useEffect(() => {
    setCurrentIndex(0);
    setPageReady(false);
    setCompleted(false);
    setStatus(items.length > 0 ? 'loading-page' : 'idle');
    clearPlayback();
  }, [session]);

  useEffect(() => {
    if (!currentItem) return undefined;

    clearPlayback();
    setPageReady(false);
    setStatus('loading-page');

    const token = pageTokenRef.current + 1;
    pageTokenRef.current = token;

    pageTimeoutRef.current = setTimeout(() => {
      if (pageTokenRef.current === token) {
        setPageReady(true);
      }
    }, currentItem.pageLoadTimeoutMs);

    return () => {
      clearTimeout(pageTimeoutRef.current);
      clearTimeout(readyDelayRef.current);
      clearTimeout(advanceTimeoutRef.current);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
    };
  }, [currentIndex, currentItem]);

  useEffect(() => {
    if (!currentItem || !pageReady || completed) return undefined;

    const token = pageTokenRef.current;
    setStatus('ready-delay');

    readyDelayRef.current = setTimeout(() => {
      if (pageTokenRef.current !== token) return;

      const audio = new Audio(currentItem.audioUrl);
      audio.preload = 'auto';
      audioRef.current = audio;

      const scheduleNext = () => {
        advanceTimeoutRef.current = setTimeout(() => {
          if (currentIndex >= items.length - 1) {
            setCompleted(true);
            setStatus('completed');
            return;
          }

          setCurrentIndex((value) => Math.min(value + 1, items.length - 1));
        }, currentItem.holdAfterAudioMs);
      };

      const playAudio = async () => {
        setStatus('playing');

        try {
          await audio.play();
        } catch {
          setStatus('error');
        }
      };

      audio.addEventListener('ended', scheduleNext, { once: true });
      audio.addEventListener('error', () => {
        setStatus('error');
      }, { once: true });

      if (audio.readyState >= 3) {
        playAudio();
      } else {
        audio.addEventListener('canplaythrough', playAudio, { once: true });
        audio.load();
      }
    }, currentItem.pageReadyDelayMs);

    return () => {
      clearTimeout(readyDelayRef.current);
    };
  }, [pageReady, completed, currentItem, currentIndex, items.length]);

  const handleFrameLoad = () => {
    clearTimeout(pageTimeoutRef.current);
    setPageReady(true);
  };

  const handleClose = () => {
    clearPlayback();
    onClose?.();
  };

  const handleRestart = () => {
    clearPlayback();
    setCompleted(false);
    setStatus('loading-page');
    setCurrentIndex(0);
  };

  const handlePrevious = () => {
    if (currentIndex <= 0) return;
    clearPlayback();
    setCompleted(false);
    setCurrentIndex((value) => Math.max(0, value - 1));
  };

  const handleNext = () => {
    if (currentIndex >= items.length - 1) return;
    clearPlayback();
    setCompleted(false);
    setCurrentIndex((value) => Math.min(items.length - 1, value + 1));
  };

  if (!currentItem) return null;

  return (
    <div className="presentation-player-overlay">
      <div className="presentation-player-toolbar">
        <div className="presentation-player-meta">
          <div className="presentation-player-kicker">固定播放器</div>
          <div className="presentation-player-title">
            <strong>{currentItem.title}</strong>
            <span>{`${currentIndex + 1} / ${items.length}`}</span>
          </div>
          <div className="presentation-player-status">{statusText}</div>
        </div>
        <div className="presentation-player-actions">
          <button onClick={handlePrevious} disabled={currentIndex === 0}>上一页</button>
          <button onClick={handleNext} disabled={currentIndex >= items.length - 1}>下一页</button>
          <button onClick={handleRestart}>重新播放</button>
          <button className="danger" onClick={handleClose}>关闭播放器</button>
        </div>
      </div>

      <div className="presentation-player-progress">
        <span style={{ width: `${progressValue}%` }} />
      </div>

      <div className="presentation-player-stage">
        <iframe
          key={currentItem.id}
          className="presentation-player-frame"
          title={currentItem.title}
          src={currentItem.page.kind === 'url' ? currentItem.page.url : undefined}
          srcDoc={currentItem.page.kind === 'srcDoc' ? currentItem.page.srcDoc : undefined}
          onLoad={handleFrameLoad}
          sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}

export default PresentationPlayerOverlay;
