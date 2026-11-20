import { getCurrentLanguage } from './index';
import type { SupportedLanguage } from './_all';

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
    viewChanged: 'The desktop picture changed. Wait for the latest picture before continuing.',
    preferredRoute: 'Connect the selected route before controlling your Mac.',
    inputBusy: 'Too many inputs are waiting. Reconnect to control your Mac.',
    phoneScreen: 'Phone Screen',
    windows: 'Windows',
    restoreWindows: 'Restore window',
    windowsLoading: 'Loading running windows…',
    windowsEmpty: 'No standard app windows are open on your Mac.',
    untitledWindow: 'Untitled window',
    windowOnPhone: 'Filled',
    windowMinimized: 'Minimized',
    virtualDisplayUnavailable: 'Phone Screen is unavailable on this Mac. Choose a physical display instead.',
    virtualDisplayRequired: 'Switch to Phone Screen before moving a window here.',
    windowUnavailable: 'That window was closed or can no longer be moved. Refresh the window list.',
    windowUnresponsive: 'That app is not responding to Accessibility right now. Try again in a moment.',
    restorePersistFailed: 'Could not save the window’s original position on your Mac. The window was not moved.',
    displayChanged: 'The display layout changed. Wait for the updated picture or reconnect.',
    keyEscape: 'Escape', keyTab: 'Tab', keyEnter: 'Return', keyBackspace: 'Delete',
    keyLeft: 'Left arrow', keyUp: 'Up arrow', keyDown: 'Down arrow', keyRight: 'Right arrow',
    keyCommand: 'Command', keyShift: 'Shift',
};
const zh: typeof en = {
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
    viewChanged: '桌面画面已变化，请等待最新画面后继续。',
    preferredRoute: '请先接通所选连接方式，再控制 Mac。',
    inputBusy: '输入等待过多，请重新连接。',
    phoneScreen: '手机竖屏',
    windows: '窗口',
    restoreWindows: '还原窗口',
    windowsLoading: '正在获取运行窗口…',
    windowsEmpty: 'Mac 上当前没有可移入的应用窗口。',
    untitledWindow: '未命名窗口',
    windowOnPhone: '当前铺满',
    windowMinimized: '已最小化',
    virtualDisplayUnavailable: '此 Mac 当前不支持手机竖屏，请改选物理显示器。',
    virtualDisplayRequired: '请先切换到手机竖屏，再移入应用窗口。',
    windowUnavailable: '该窗口已关闭或无法移动，请刷新窗口列表。',
    windowUnresponsive: '目标应用暂未响应辅助功能请求，请稍后重试。',
    restorePersistFailed: '无法在 Mac 上保存窗口原始位置，已取消移动窗口。',
    displayChanged: '显示器布局已变化，请等待画面更新或重新连接。',
    keyEscape: 'Esc 键', keyTab: 'Tab 键', keyEnter: '回车', keyBackspace: '退格',
    keyLeft: '左方向键', keyUp: '上方向键', keyDown: '下方向键', keyRight: '右方向键',
    keyCommand: 'Command', keyShift: 'Shift',
};
const zhHant: typeof en = {
    previousDesktop: '上一個桌面', nextDesktop: '下一個桌面', overview: '桌面總覽',
    spaceUnconfirmed: '未確認桌面切換，請查看畫面，或透過桌面總覽選擇。',
    spaceShortcut: '請在 Mac 系統設定 → 鍵盤 → 鍵盤快速鍵 → Mission Control 中啟用桌面切換快速鍵。',
    exit: '結束遠端桌面', back: '返回', controls: '控制', showControls: '顯示控制', connection: '連線狀態', connected: '已連線', desktops: '桌面', zoomIn: '放大', zoomOut: '縮小',
    settings: '畫面', close: '關閉', fullscreen: '全螢幕', exitFullscreen: '結束全螢幕', pointer: '指標', disconnecting: '正在中斷連線…',
    title: '遠端桌面', connect: '連線', disconnect: '中斷連線', refresh: '重新整理', connecting: '正在連線…', checking: '正在檢查 Mac…', notConnected: '未連線', inputChecking: '正在確認控制權限…', waiting: '等待畫面…',
    clarity: '清晰度', smoothness: '流暢度', standard: '標準', high: '高畫質', ultra: '超高畫質', display: '顯示器',
    text: '輸入文字', send: '輸入', zoom: '縮放', fit: '符合畫面', drag: '拖曳', rightClick: '右鍵', scroll: '捲動', keyboard: '鍵盤',
    disabled: '請在 Mac 上開啟遠端桌面。', unavailable: '無法連線至 Mac，請檢查連線後再試。',
    permission: '請在 Mac 上允許螢幕錄製。', inputPermission: '請在 Mac 上允許輔助使用以進行控制。', locked: '請先解鎖 Mac。',
    failed: '桌面連線失敗，請檢查 Mac 上的媒體 Relay。', inUse: '已有桌面連線，請先中斷。', changed: '顯示器或連線已變更，請重新連線。',
    uncertain: '操作結果待確認，請查看桌面後再決定是否重複操作。',
    viewChanged: '桌面畫面已變更，請等待最新畫面後繼續。',
    preferredRoute: '請先接通所選連線方式，再控制 Mac。',
    inputBusy: '輸入等待過多，請重新連線。',
    phoneScreen: '手機直向螢幕',
    windows: '視窗',
    restoreWindows: '還原視窗',
    windowsLoading: '正在載入執行中的視窗…',
    windowsEmpty: 'Mac 上目前沒有可移入的應用程式視窗。',
    untitledWindow: '未命名視窗',
    windowOnPhone: '目前已鋪滿',
    windowMinimized: '已最小化（視窗）',
    virtualDisplayUnavailable: '此 Mac 目前不支援手機直向螢幕，請改選實體顯示器。',
    virtualDisplayRequired: '請先切換至手機直向螢幕，再移入應用程式視窗。',
    windowUnavailable: '該視窗已關閉或無法移動，請重新整理視窗列表。',
    windowUnresponsive: '目標應用程式暫未回應輔助使用請求，請稍後再試。',
    restorePersistFailed: '無法在 Mac 上儲存視窗原始位置，已取消移動視窗。',
    displayChanged: '顯示器版面已變更，請等待畫面更新或重新連線。',
    keyEscape: 'Esc 鍵', keyTab: 'Tab 鍵', keyEnter: '換行', keyBackspace: '退格',
    keyLeft: '左方向鍵', keyUp: '上方向鍵', keyDown: '下方向鍵', keyRight: '右方向鍵',
    keyCommand: 'Command', keyShift: 'Shift',
};
const ja: typeof en = {
    previousDesktop: '前のデスクトップ', nextDesktop: '次のデスクトップ', overview: 'Mission Control',
    spaceUnconfirmed: 'デスクトップの切り替えを確認できません。画面を確認するか、Mission Control で選択してください。',
    spaceShortcut: 'Mac のシステム設定 → キーボード → キーボードショートカット → Mission Control でデスクトップ切り替えを有効にしてください。',
    exit: 'リモートデスクトップを終了', back: '戻る', controls: '操作', showControls: '操作を表示', connection: '接続', connected: '接続済み', desktops: 'デスクトップ', zoomIn: '拡大', zoomOut: '縮小',
    settings: '画質', close: '閉じる', fullscreen: '全画面', exitFullscreen: '全画面を終了', pointer: 'ポインタ', disconnecting: '切断中…',
    title: 'リモートデスクトップ', connect: '接続', disconnect: '切断', refresh: '更新',
    connecting: '接続中…', checking: 'Mac を確認中…', notConnected: '未接続', inputChecking: '操作の権限を確認中…', waiting: '映像を待機中…', clarity: '解像度', smoothness: '滑らかさ',
    standard: '標準', high: '高画質', ultra: '最高画質', display: 'ディスプレイ', text: 'テキストを入力', send: '入力',
    zoom: 'ズーム', fit: '画面に合わせる', drag: 'ドラッグ', rightClick: '右クリック', scroll: 'スクロール', keyboard: 'キーボード',
    disabled: 'Mac でリモートデスクトップを有効にしてください。', unavailable: 'Mac に接続できません。接続を確認して再試行してください。',
    permission: 'Mac で画面収録を許可してください。', inputPermission: 'Mac を操作するにはアクセシビリティを許可してください。',
    locked: 'Mac のロックを解除してください。', failed: '接続に失敗しました。Mac のメディア Relay を確認してください。',
    inUse: '別のデスクトップ接続が使用中です。先に切断してください。', changed: 'ディスプレイまたは接続が変わりました。再接続してください。',
    uncertain: '操作結果は未確認です。繰り返す前にデスクトップを確認してください。',
    viewChanged: 'デスクトップの映像が変わりました。最新の映像を待ってから続けてください。',
    preferredRoute: 'Mac を操作する前に、選択した接続を確立してください。',
    inputBusy: '入力待ちが多すぎます。Mac を操作するには再接続してください。',
    phoneScreen: 'スマホ縦画面',
    windows: 'ウインドウ',
    restoreWindows: 'ウインドウを元の位置に戻す',
    windowsLoading: '実行中のウインドウを読み込み中…',
    windowsEmpty: 'Mac で開いている対象ウインドウがありません。',
    untitledWindow: '名称未設定のウインドウ',
    windowOnPhone: '表示中',
    windowMinimized: '最小化',
    virtualDisplayUnavailable: 'この Mac ではスマホ縦画面を利用できません。物理ディスプレイを選択してください。',
    virtualDisplayRequired: 'ウインドウを移動するには、先にスマホ縦画面へ切り替えてください。',
    windowUnavailable: 'このウインドウは閉じられたか移動できません。一覧を更新してください。',
    windowUnresponsive: '対象のアプリがアクセシビリティに応答していません。しばらくしてから再試行してください。',
    restorePersistFailed: 'Mac 上でウインドウの元の位置を保存できなかったため、移動を中止しました。',
    displayChanged: 'ディスプレイ構成が変わりました。映像の更新を待つか再接続してください。',
    keyEscape: 'エスケープ', keyTab: 'タブ', keyEnter: '改行', keyBackspace: '削除',
    keyLeft: '左矢印', keyUp: '上矢印', keyDown: '下矢印', keyRight: '右矢印',
    keyCommand: 'コマンド', keyShift: 'シフト',
};
export function remoteDesktopLabelsFor(language: SupportedLanguage) {
    return language === 'ja' ? ja : language === 'zh-Hant' ? zhHant : language.startsWith('zh') ? zh : en;
}
export function remoteDesktopLabels() { return remoteDesktopLabelsFor(getCurrentLanguage()); }
export function remoteDesktopError(code: string) {
    const labels = remoteDesktopLabels();
    if (code === 'desktop-disabled') return labels.disabled;
    if (code === 'desktop-screen-permission-required') return labels.permission;
    if (code === 'desktop-input-permission-required' || code === 'desktop-accessibility-required') return labels.inputPermission;
    if (code === 'desktop-virtual-display-unavailable') return labels.virtualDisplayUnavailable;
    if (code === 'desktop-virtual-display-required') return labels.virtualDisplayRequired;
    if (code === 'desktop-window-unavailable') return labels.windowUnavailable;
    if (code === 'desktop-window-unresponsive') return labels.windowUnresponsive;
    if (code === 'desktop-restore-persist-failed') return labels.restorePersistFailed;
    if (code === 'desktop-locked') return labels.locked;
    if (code === 'desktop-in-use') return labels.inUse;
    if (code === 'desktop-operation-unknown') return labels.uncertain;
    if (code === 'desktop-view-changed') return labels.viewChanged;
    if (code === 'desktop-display-changed') return labels.displayChanged;
    if (code === 'preferred-route-unavailable') return labels.preferredRoute;
    if (code === 'desktop-input-busy') return labels.inputBusy;
    if (code === 'desktop-space-unconfirmed') return labels.spaceUnconfirmed;
    if (['desktop-space-shortcut-disabled', 'desktop-space-shortcut-unavailable'].includes(code)) return labels.spaceShortcut;
    if (['desktop-disconnected', 'desktop-request-expired'].includes(code)) return labels.changed;
    if (code === 'desktop-relay-unavailable' || code === 'desktop-media-connect-failed') return labels.failed;
    return labels.unavailable;
}
