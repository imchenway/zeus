import { ArrowsInSimpleIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsInSimple';
import { ArrowsOutSimpleIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { PauseIcon as Pause } from '@phosphor-icons/react/dist/csr/Pause';
import { PlayIcon as Play } from '@phosphor-icons/react/dist/csr/Play';
import { SpeakerHighIcon as SpeakerHigh } from '@phosphor-icons/react/dist/csr/SpeakerHigh';
import { SpeakerXIcon as SpeakerX } from '@phosphor-icons/react/dist/csr/SpeakerX';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '../ui/Button.js';
import './videoPlayer.css';

/** 指针停止移动后，控制条保持可见的时间，单位为毫秒。 */
const controlsHideDelay = 1800;

/** 将媒体时间从秒转换为进度栏使用的分秒格式。 */
function videoTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/** 仅在媒体明确没有音轨时隐藏音量，探测不到轨道时保留原有操作。 */
function hasAudioTrack(element: HTMLVideoElement): boolean {
  /** Chromium 在元数据就绪后从已选轨道创建捕获流。 */
  const media = element as HTMLVideoElement & { captureStream?: () => MediaStream };
  try {
    /** 只读取轨道种类，立即停止探测用轨道。 */
    const tracks = media.captureStream?.().getTracks();
    if (!tracks?.length) return true;
    /** 所有在捕获流中可用的音轨都要保留音量入口。 */
    const hasAudio = tracks.some((track) => track.kind === 'audio');
    tracks.forEach((track) => track.stop());
    return hasAudio;
  } catch {
    return true;
  }
}

/** 对话视频按原画幅显示，播放控件在画面右下角按需展开。 */
export function VideoPlayer(props: { url: string; name: string; zh: boolean; onError: () => void }) {
  /** 全屏和正文使用同一个播放器容器。 */
  const player = useRef<HTMLDivElement>(null);
  /** 播放与拖动直接操作原生媒体元素。 */
  const video = useRef<HTMLVideoElement>(null);
  /** 指针在控件内操作时，延迟收起。 */
  const controls = useRef<HTMLDivElement>(null);
  /** 每次指针活动都替换此前的收起计时。 */
  const hideTimer = useRef<number | undefined>(undefined);
  /** 元数据就绪前用 16:9 占位，读取后按视频宽高比排版。 */
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  /** 播放总时长，单位为秒。 */
  const [duration, setDuration] = useState(0);
  /** 播放当前位置，单位为秒。 */
  const [currentTime, setCurrentTime] = useState(0);
  /** 通过原生媒体事件同步实际播放状态。 */
  const [playing, setPlaying] = useState(false);
  /** 鼠标唤起的控制条，键盘焦点可独立保持控制条展开。 */
  const [controlsRevealed, setControlsRevealed] = useState(false);
  /** 未确定音轨之前保留音量操作。 */
  const [hasAudio, setHasAudio] = useState(true);
  /** 音量范围为 0 到 1，静音保留先前音量。 */
  const [volume, setVolume] = useState(1);
  /** 静音图标与实际媒体状态同步。 */
  const [muted, setMuted] = useState(false);
  /** 原生全屏状态同时覆盖按钮操作和 Escape 退出。 */
  const [fullscreen, setFullscreen] = useState(false);
  /** 浏览器拒绝切换全屏时显示当前操作的错误。 */
  const [fullscreenError, setFullscreenError] = useState(false);
  /** 播放按钮说明下一步操作。 */
  const playbackLabel = playing ? (props.zh ? '暂停' : 'Pause') : props.zh ? '播放' : 'Play';
  /** 静音按钮说明下一步操作。 */
  const muteLabel = muted ? (props.zh ? '取消静音' : 'Unmute') : props.zh ? '静音' : 'Mute';
  /** 全屏按钮与原生全屏状态同步。 */
  const fullscreenLabel = fullscreen ? (props.zh ? '退出全屏' : 'Exit full screen') : props.zh ? '全屏' : 'Full screen';
  /** 时长未知时只显示播放入口。 */
  const totalTime = duration > 0 ? videoTime(duration) : '';
  /** 进度条与读屏使用同一个当前时间。 */
  const elapsedTime = videoTime(currentTime);

  useEffect(() => {
    /** 全屏事件来自播放器所在窗口。 */
    const element = player.current;
    if (!element) return;
    /** 监听进入全屏和通过 Escape 退出。 */
    function syncFullscreen() {
      setFullscreen(element?.ownerDocument.fullscreenElement === element);
    }
    element.addEventListener('fullscreenchange', syncFullscreen);
    return () => {
      element.removeEventListener('fullscreenchange', syncFullscreen);
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  /** 保持视频宽高比，同时允许对话限制竖屏视频的高度。 */
  function syncAspectRatio(element: HTMLVideoElement): void {
    if (element.videoWidth && element.videoHeight) setAspectRatio(element.videoWidth / element.videoHeight);
  }

  /** 播放结束或指针离开时退回收起状态。 */
  function hideControls(): void {
    window.clearTimeout(hideTimer.current);
    setControlsRevealed(false);
  }

  /** 指针活动展开控制条，指针停在控件上时暂停收起。 */
  function revealControls(): void {
    if (!controlsRevealed) setControlsRevealed(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!controls.current?.matches(':hover, :active')) setControlsRevealed(false);
    }, controlsHideDelay);
  }

  /** 点击画面与播放按钮共享原生播放动作，解码失败交由附件入口处理。 */
  function togglePlayback(): void {
    /** 原生状态也能反映视频结束后再次播放。 */
    const element = video.current;
    if (!element) return;
    if (element.paused) {
      void element.play().catch((error: DOMException) => {
        if (error.name !== 'AbortError') props.onError();
      });
    } else {
      element.pause();
    }
  }

  /** 全屏时保留同一组播放控件。 */
  function toggleFullscreen(): void {
    /** 全屏容器包含视频和控制条。 */
    const element = player.current;
    if (!element) return;
    /** 原生全屏属于播放器所在窗口。 */
    const doc = element.ownerDocument;
    setFullscreenError(false);
    void (doc.fullscreenElement === element ? doc.exitFullscreen() : element.requestFullscreen()).catch(() => setFullscreenError(true));
  }

  return (
    <div
      ref={player}
      className="zeus-video-player"
      role="group"
      aria-label={props.name}
      data-playing={playing || undefined}
      style={{ '--zeus-video-ratio': aspectRatio } as CSSProperties}
      onPointerMove={() => {
        if (playing || controlsRevealed) revealControls();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'touch') hideControls();
      }}
    >
      <video
        ref={video}
        crossOrigin="anonymous"
        preload="metadata"
        playsInline
        src={props.url}
        aria-label={props.name}
        onClick={togglePlayback}
        onLoadedMetadata={(event) => {
          syncAspectRatio(event.currentTarget);
          setHasAudio(hasAudioTrack(event.currentTarget));
        }}
        onResize={(event) => syncAspectRatio(event.currentTarget)}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => {
          setPlaying(true);
          revealControls();
        }}
        onPause={() => {
          setPlaying(false);
          revealControls();
        }}
        onEnded={() => {
          setPlaying(false);
          hideControls();
        }}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onError={props.onError}
      />
      <div ref={controls} className="zeus-video-controls" data-revealed={controlsRevealed || undefined} data-audio={hasAudio || undefined}>
        <Button
          unstyled
          type="button"
          className="zeus-video-play"
          aria-label={playbackLabel}
          aria-description={totalTime ? (props.zh ? `时长 ${totalTime}` : `Duration ${totalTime}`) : undefined}
          data-icon-tooltip={playbackLabel}
          onClick={togglePlayback}
        >
          {playing ? <Pause size={14} weight="fill" aria-hidden="true" /> : <Play size={14} weight="fill" aria-hidden="true" />}
          {totalTime ? (
            <span className="zeus-video-duration" aria-hidden="true">
              {totalTime}
            </span>
          ) : null}
        </Button>
        <input
          className="zeus-video-seek"
          type="range"
          aria-label={props.zh ? '播放进度' : 'Playback position'}
          aria-valuetext={totalTime ? `${elapsedTime} / ${totalTime}` : elapsedTime}
          max={duration || 1}
          min={0}
          step="any"
          disabled={!duration}
          value={Math.min(currentTime, duration)}
          style={{ '--zeus-video-progress': duration ? `${(100 * Math.min(currentTime, duration)) / duration}%` : '0%' } as CSSProperties}
          onChange={(event) => {
            if (video.current) video.current.currentTime = event.currentTarget.valueAsNumber;
            setCurrentTime(event.currentTarget.valueAsNumber);
          }}
        />
        <span className="zeus-video-time" aria-hidden="true">
          <span>{elapsedTime}</span>
          {totalTime ? <span className="zeus-video-total"> / {totalTime}</span> : null}
        </span>
        {hasAudio ? (
          <>
            <Button
              unstyled
              type="button"
              className="zeus-video-mute"
              aria-label={muteLabel}
              data-icon-tooltip={muteLabel}
              onClick={() => {
                if (video.current) video.current.muted = !video.current.muted;
              }}
            >
              {muted || !volume ? <SpeakerX size={16} aria-hidden="true" /> : <SpeakerHigh size={16} aria-hidden="true" />}
            </Button>
            <input
              className="zeus-video-volume"
              type="range"
              aria-label={props.zh ? '音量' : 'Volume'}
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              style={{ '--zeus-video-progress': `${muted ? 0 : volume * 100}%` } as CSSProperties}
              onChange={(event) => {
                if (!video.current) return;
                video.current.volume = event.currentTarget.valueAsNumber;
                video.current.muted = false;
              }}
            />
          </>
        ) : null}
        <Button unstyled type="button" className="zeus-video-fullscreen" aria-label={fullscreenLabel} data-icon-tooltip={fullscreenLabel} onClick={toggleFullscreen}>
          {fullscreen ? <ArrowsIn size={15} weight="bold" aria-hidden="true" /> : <ArrowsOut size={15} weight="bold" aria-hidden="true" />}
        </Button>
      </div>
      {fullscreenError ? (
        <small className="zeus-video-error" role="status">
          {props.zh ? '无法切换全屏。' : 'Full screen is unavailable.'}
        </small>
      ) : null}
    </div>
  );
}
