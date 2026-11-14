'use client';

// 安卓壳里的长按粘贴（2026-11-14）：Capacitor WebView 的原生粘贴菜单在部分设备上
// 不弹（已知问题类），壳内长按输入框 = 直接把剪贴板内容插进光标处，绕开原生菜单。
//
// 边界：
// - 仅原生壳生效（Capacitor.isNativePlatform()）——浏览器右键菜单/长按行为零改动；
// - 读剪贴板走 @capacitor/clipboard 原生桥（应用在前台时 Android 允许读自身剪贴板）；
// - 读失败时这次长按无反应，键盘的粘贴键仍是兜底（不弹任何错误，全站无红字口径）；
// - React 受控输入必须走原生 value setter + input 事件，否则状态不更新（insert 内处理）。
import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';

type EditableEl = HTMLInputElement | HTMLTextAreaElement;

function isEditable(target: EventTarget | null): target is EditableEl {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    return !['button', 'submit', 'checkbox', 'radio', 'file'].includes(t);
  }
  return el.isContentEditable;
}

/** 把文本插到光标处并触发 input 事件（React 受控组件必须走原型 setter） */
function insertAtCursor(el: EditableEl, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  setter?.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const pos = Math.min(start + text.length, next.length);
  try {
    el.setSelectionRange(pos, pos);
  } catch {
    // 某些 input 类型不支持 setSelectionRange，忽略
  }
  el.focus();
}

export default function ShellPaste() {
  useEffect(() => {
    // 壳判定放模块加载后运行时——SSR 没有 Capacitor 全局，直接短路径返回
    if (!Capacitor.isNativePlatform()) return;
    // 只对 Android 摘菜单：iOS 长按粘贴原生工作，contextmenu 也不是它的长按事件
    if (Capacitor.getPlatform() !== 'android') return;

    const onContextMenu = (e: MouseEvent) => {
      const el = e.target;
      if (!isEditable(el)) return;
      // 原生菜单本来就弹不出来——直接拦掉，换成"长按即贴"
      e.preventDefault();
      Clipboard.read()
        .then(({ value }) => {
          const text = value ?? '';
          if (text) insertAtCursor(el, text);
        })
        .catch(() => {
          // 读剪贴板失败：安静放弃（键盘粘贴键兜底），不弹任何提示
        });
    };
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, []);

  return null;
}
