'use client';

// 「按一下说」按钮（V0.2 批 D1，docs/02 §20.4）——经典版「合」（DayCloseCard）与
// 新版一幕（ActCard commitSheet）共享的落点。点一下开始说，再点一下结束。
//
// 录音在浏览器采集（MediaRecorder，60 秒封顶自动停），POST /api/journey/speech
// 服务端转写，文本由调用方填进输入框——提交仍走原路，安全层不绕过（D2）。
// 边界：失败/没听清/权限被拒只给一行灰字，**不卡提交**（打字一直在）；
// 不分析、不提醒，转写完成音频即弃（音频不落任何地方）。
import { useRef, useState } from 'react';

/** 全站同一时刻最多一段录音在采（多个落点共享一条麦克风）：开始前停掉别处的 */
let stopActiveSpeech: (() => void) | null = null;

export default function SpeechButton({
  startLabel,
  stopLabel,
  failedLabel,
  disabled,
  onText,
}: {
  startLabel: string;
  stopLabel: string;
  failedLabel: string;
  disabled?: boolean;
  onText: (text: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stop() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') rec.stop();
  }

  async function transcribe() {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (stopActiveSpeech === stop) stopActiveSpeech = null;
    setRecording(false);
    if (!rec) return;
    const type = rec.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type });
    chunksRef.current = [];
    if (blob.size === 0) {
      setHint(true); // 一段都没录上——没听清
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('audio', blob, type.includes('mp4') ? 'audio.mp4' : 'audio.webm');
      const res = await fetch('/api/journey/speech', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { text?: unknown };
      const text = typeof data.text === 'string' ? data.text.trim().slice(0, 300) : '';
      if (text) onText(text);
      else setHint(true); // 转写为空（静音/没听清）与失败同口径：打字也可以
    } catch {
      setHint(true); // 失败不卡提交（产品边界），灰字提示即可
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (recording || busy || disabled) return;
    setHint(false);
    stopActiveSpeech?.(); // 别处正在录：先停它（那段照常走转写）
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setHint(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : undefined;
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void transcribe();
      };
      recorderRef.current = rec;
      stopActiveSpeech = stop;
      setRecording(true);
      rec.start();
      timerRef.current = setTimeout(stop, 60_000); // 说忘了也会自己停，麦克风不会一直开着
    } catch {
      setHint(true); // 权限被拒等：不弹红字，打字也可以
    }
  }

  return (
    <span className="mt-2 inline-flex items-center gap-3">
      <button
        type="button"
        aria-pressed={recording}
        data-speech-button=""
        disabled={disabled || busy}
        onClick={() => (recording ? stop() : void start())}
        className={`text-xs underline underline-offset-4 transition-colors ${
          recording ? 'text-ink' : 'text-ink-soft hover:text-ink'
        } disabled:opacity-40`}
      >
        {busy ? '…' : recording ? stopLabel : startLabel}
      </button>
      {hint && <span className="text-xs text-ink-soft/70">{failedLabel}</span>}
    </span>
  );
}
