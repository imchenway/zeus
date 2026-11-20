import { ArrowsInSimpleIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsInSimple';
import { ArrowsOutSimpleIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { PauseIcon as Pause } from '@phosphor-icons/react/dist/csr/Pause';
import { PlayIcon as Play } from '@phosphor-icons/react/dist/csr/Play';
import { SpeakerHighIcon as SpeakerHigh } from '@phosphor-icons/react/dist/csr/SpeakerHigh';
import { SpeakerXIcon as SpeakerX } from '@phosphor-icons/react/dist/csr/SpeakerX';
import { useRef, useState, type MouseEvent } from 'react';
import { Button } from '../ui/Button.js';
import './videoPlayer.css';

/** 将媒体时间从秒转换为进度栏使用的分秒格式。 */
function videoTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/** 原生视频负责解码和跳转，控件独立于画面，方便查看屏幕录制中的细节。 */
export function VideoPlayer(props: { url: string; name: string; zh: boolean; onError: () => void }) {
  /** 读取实际视频状态并将全屏限制在当前播放器。 */
  const video = useRef<HTMLVideoElement>(null);
  /** 元数据就绪前，进度条不可编辑。 */
  const [duration, setDuration] = useState(0);
  /** 当前位置由浏览器事件更新，单位为秒。 */
  const [currentTime, setCurrentTime] = useState(0);
  /** 通过播放事件反映实际状态，包括视频结束。 */
  const [playing, setPlaying] = useState(false);
  /** 音量范围为 0 到 1，静音保留先前音量。 */
  const [volume, setVolume] = useState(1);
  /** 静音图标与实际媒体状态同步。 */
  const [muted, setMuted] = useState(false);
  /** 浏览器拒绝全屏时仍可继续在正文播放。 */
  const [fullscreenError, setFullscreenError] = useState(false);
  /** 可访问名称和悬停提示都显示下一步操作。 */
  const playbackLabel = playing ? (props.zh ? '暂停' : 'Pause') : props.zh ? '播放' : 'Play';
  /** 静音切换保留当前音量滑块的位置。 */
  const muteLabel = muted ? (props.zh ? '取消静音' : 'Unmute') : props.zh ? '静音' : 'Mute';

  /** 键盘和鼠标均可启动播放，解码失败由调用方提供备用打开方式。 */
  function togglePlayback(): void {
    const element = video.current;
    if (!element) return;
    if (element.paused)
      void element.play().catch((error: DOMException) => {
        if (error.name !== 'AbortError') props.onError();
      });
    else element.pause();
  }

  /** 原生全屏保留画面和控件，使用 Escape 或同一按钮退出。 */
  function toggleFullscreen(event: MouseEvent<HTMLButtonElement>): void {
    /** 全屏容器包含同一组可聚焦的播放控件。 */
    const player = event.currentTarget.closest('.zeus-video-player');
    if (!player) return;
    /** 使用播放器所在窗口的全屏状态。 */
    const doc = player.ownerDocument;
    setFullscreenError(false);
    void (doc.fullscreenElement === player ? doc.exitFullscreen() : player.requestFullscreen()).catch(() => setFullscreenError(true));
  }

  return (
    <div className="zeus-video-player" role="group" aria-label={props.name}>
      <video
        ref={video}
        preload="metadata"
        playsInline
        src={props.url}
        aria-label={props.name}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onError={props.onError}
      />
      <div className="zeus-video-controls">
        <Button unstyled type="button" aria-label={playbackLabel} data-icon-tooltip={playbackLabel} onClick={togglePlayback}>
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </Button>
        <input
          type="range"
          aria-label={props.zh ? '播放进度' : 'Playback position'}
          aria-valuetext={videoTime(currentTime)}
          max={duration || 1}
          min={0}
          step="any"
          disabled={!duration}
          value={Math.min(currentTime, duration)}
          onChange={(event) => {
            if (video.current) video.current.currentTime = event.currentTarget.valueAsNumber;
            setCurrentTime(event.currentTarget.valueAsNumber);
          }}
        />
        <span className="zeus-video-time">
          {videoTime(currentTime)} / {videoTime(duration)}
        </span>
        <Button
          unstyled
          type="button"
          aria-label={muteLabel}
          data-icon-tooltip={muteLabel}
          onClick={() => {
            if (video.current) video.current.muted = !video.current.muted;
          }}
        >
          {muted || !volume ? <SpeakerX aria-hidden="true" /> : <SpeakerHigh aria-hidden="true" />}
        </Button>
        <input
          className="zeus-video-volume"
          type="range"
          aria-label={props.zh ? '音量' : 'Volume'}
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(event) => {
            if (!video.current) return;
            video.current.volume = event.currentTarget.valueAsNumber;
            video.current.muted = false;
          }}
        />
        <Button unstyled type="button" aria-label={props.zh ? '切换全屏' : 'Toggle full screen'} data-icon-tooltip={props.zh ? '切换全屏' : 'Toggle full screen'} onClick={toggleFullscreen}>
          <ArrowsOut className="zeus-video-enter-fullscreen" aria-hidden="true" />
          <ArrowsIn className="zeus-video-exit-fullscreen" aria-hidden="true" />
        </Button>
      </div>
      {fullscreenError ? <small role="status">{props.zh ? '无法进入全屏。' : 'Full screen is unavailable.'}</small> : null}
    </div>
  );
}
