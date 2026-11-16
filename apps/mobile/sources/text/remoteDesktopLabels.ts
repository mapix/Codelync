import { getCurrentLanguage } from './index';

const en = {
    previousDesktop: 'Previous desktop', nextDesktop: 'Next desktop', overview: 'Mission Control',
    spaceUnconfirmed: 'Desktop change was not confirmed. Check the picture or choose a desktop in Mission Control.',
    spaceShortcut: 'Enable your desktop switching shortcuts in Mac System Settings → Keyboard → Keyboard Shortcuts → Mission Control.',
    exit: 'Exit remote desktop', back: 'Back', controls: 'Controls', showControls: 'Show controls', connection: 'Connection', connected: 'Connected', desktops: 'Desktops', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
    settings: 'Picture', close: 'Close', fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen', pointer: 'Pointer', disconnecting: 'Disconnecting…',
    title: 'Remote desktop', connect: 'Connect', disconnect: 'Disconnect', refresh: 'Refresh',
    connecting: 'Connecting…', checking: 'Checking your Mac…', notConnected: 'Not connected', inputChecking: 'Checking control permissions…', waiting: 'Waiting for video…', clarity: 'Clarity', smoothness: 'Smoothness',
    standard: 'Standard', high: 'High', ultra: 'Ultra', display: 'Display', text: 'Type text', send: 'Type',
    zoom: 'Zoom', fit: 'Fit', drag: 'Drag', rightClick: 'Right click', scroll: 'Scroll', keyboard: 'Keyboard',
    disabled: 'Enable remote desktop on your Mac.', unavailable: 'Could not reach your Mac. Check the connection and try again.',
    permission: 'Allow screen recording on your Mac to connect.', inputPermission: 'Allow Accessibility on your Mac to control it.',
    locked: 'Unlock your Mac to connect.', failed: 'Desktop connection failed. Check the media relay on your Mac.',
    inUse: 'Another desktop connection is active. End it first.', changed: 'The display or connection changed. Connect again.',
    uncertain: 'The action result is unconfirmed. Check the desktop before repeating it.',
    inputBusy: 'Too many inputs are waiting. Reconnect to control your Mac.',
};
const zh = {
    previousDesktop: '上一桌面', nextDesktop: '下一桌面', overview: '桌面总览',
    spaceUnconfirmed: '未确认桌面切换，请查看画面，或通过桌面总览选择。',
    spaceShortcut: '请在 Mac 系统设置 → 键盘 → 键盘快捷键 → Mission Control 中启用桌面切换快捷键。',
    exit: '退出远程桌面', back: '返回', controls: '控制', showControls: '显示控制', connection: '连接状态', connected: '已连接', desktops: '桌面', zoomIn: '放大', zoomOut: '缩小',
    settings: '画面', close: '关闭', fullscreen: '全屏', exitFullscreen: '退出全屏', pointer: '指针', disconnecting: '正在断开…',
    title: '远程桌面', connect: '连接', disconnect: '断开', refresh: '刷新', connecting: '正在连接…', checking: '正在检查 Mac…', notConnected: '未连接', inputChecking: '正在确认控制权限…', waiting: '等待画面…',
    clarity: '清晰度', smoothness: '流畅度', standard: '标清', high: '高清', ultra: '超清', display: '显示器',
    text: '输入文字', send: '输入', zoom: '缩放', fit: '适应', drag: '拖动', rightClick: '右键', scroll: '滚动', keyboard: '键盘',
    disabled: '请在 Mac 上开启远程桌面。', unavailable: '无法连接 Mac，请检查连接后重试。',
    permission: '请在 Mac 上允许屏幕录制。', inputPermission: '请在 Mac 上允许辅助功能以进行控制。', locked: '请先解锁 Mac。',
    failed: '桌面连接失败，请检查 Mac 上的媒体 Relay。', inUse: '已有桌面连接，请先断开。', changed: '显示器或连接已变化，请重新连接。',
    uncertain: '操作结果待确认，请查看桌面后再决定是否重复操作。',
    inputBusy: '输入等待过多，请重新连接。',
};
export function remoteDesktopLabels() { return getCurrentLanguage().startsWith('zh') ? zh : en; }
export function remoteDesktopError(code: string) {
    const labels = remoteDesktopLabels();
    if (code === 'desktop-disabled') return labels.disabled;
    if (code === 'desktop-screen-permission-required') return labels.permission;
    if (code === 'desktop-input-permission-required') return labels.inputPermission;
    if (code === 'desktop-locked') return labels.locked;
    if (code === 'desktop-in-use') return labels.inUse;
    if (code === 'desktop-operation-unknown') return labels.uncertain;
    if (code === 'desktop-input-busy') return labels.inputBusy;
    if (code === 'desktop-space-unconfirmed') return labels.spaceUnconfirmed;
    if (['desktop-space-shortcut-disabled', 'desktop-space-shortcut-unavailable'].includes(code)) return labels.spaceShortcut;
    if (['desktop-disconnected', 'desktop-display-changed', 'desktop-request-expired'].includes(code)) return labels.changed;
    if (code === 'desktop-relay-unavailable' || code === 'desktop-media-connect-failed') return labels.failed;
    return labels.unavailable;
}
