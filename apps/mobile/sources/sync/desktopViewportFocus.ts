export type DesktopViewport = { width: number; height: number };
export type DesktopViewportCamera = { zoom: number; offset: { x: number; y: number } };
export type DesktopViewportTarget = { x: number; y: number };

/** Keep a selected desktop point readable when the local keyboard shrinks video. */
export function desktopViewportFocus(
    display: DesktopViewport,
    previous: DesktopViewport,
    next: DesktopViewport,
    camera: DesktopViewportCamera,
    target: DesktopViewportTarget | null,
): DesktopViewportCamera | null {
    if (!target || ![display.width, display.height, previous.width, previous.height, next.width, next.height, camera.zoom]
        .every(value => Number.isFinite(value) && value > 0)
        || ![camera.offset.x, camera.offset.y, target.x, target.y].every(Number.isFinite)
        || target.x < 0 || target.x > 1 || target.y < 0 || target.y > 1) return null;

    const previousScale = Math.min(previous.width / display.width, previous.height / display.height) * camera.zoom;
    const nextFit = Math.min(next.width / display.width, next.height / display.height);
    if (!Number.isFinite(previousScale) || !Number.isFinite(nextFit) || previousScale <= 0 || nextFit <= 0) return null;
    const zoom = Math.min(4, Math.max(1, previousScale / nextFit));
    const scale = nextFit * zoom;
    const offset = { x: (.5 - target.x) * display.width * scale, y: (.5 - target.y) * display.height * scale };
    return [offset.x, offset.y].every(Number.isFinite) ? { zoom, offset } : null;
}
