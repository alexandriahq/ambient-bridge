export type CompactAuthPlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd"
  | "browser";

export type CompactAuthRectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type CompactAuthWindowBoundsInput = {
  readonly platform?: CompactAuthPlatform;
  readonly displayBounds: CompactAuthRectangle;
  readonly displayWorkArea: CompactAuthRectangle;
  readonly width?: number;
  readonly height?: number;
  readonly topInset?: number;
};

export type CompactAuthWindowBlackoutHtmlInput = {
  readonly appName?: string;
};

export type CompactAuthWindowTransitionBoundsInput = {
  readonly from: CompactAuthRectangle;
  readonly to: CompactAuthRectangle;
  readonly progress: number;
};

export type CompactAuthWindowHtmlInput = {
  readonly title?: string;
  readonly detail?: string;
  readonly appName?: string;
  readonly cancelLabel?: string;
  readonly cancelUrl?: string;
};

export type CompactAuthFullScreenWindow = {
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  once(event: "leave-full-screen" | "closed", listener: () => void): unknown;
  off(event: "leave-full-screen" | "closed", listener: () => void): unknown;
};

export type CompactAuthMaximizedWindow = {
  isMaximized(): boolean;
  unmaximize(): void;
  once(event: "unmaximize" | "closed", listener: () => void): unknown;
  off(event: "unmaximize" | "closed", listener: () => void): unknown;
};

export declare const COMPACT_AUTH_WINDOW_EVENT_SCHEME: "ambient-compact-auth:";
export declare const DEFAULT_COMPACT_AUTH_TITLE: "Sign into your Ambient Account";
export declare const DEFAULT_COMPACT_AUTH_WINDOW_WIDTH: 560;
export declare const DEFAULT_COMPACT_AUTH_WINDOW_HEIGHT: 128;
export declare const COMPACT_AUTH_WINDOW_BLACKOUT_LEAD_MS: 24;
export declare const COMPACT_AUTH_WINDOW_TRANSITION_FRAME_MS: 16;
export declare const COMPACT_AUTH_WINDOW_TRANSITION_MS: 180;

export declare function compactAuthWindowBlackoutHtml(input?: CompactAuthWindowBlackoutHtmlInput): string;
export declare function compactAuthWindowBounds(input: CompactAuthWindowBoundsInput): CompactAuthRectangle;
export declare function compactAuthWindowTransitionBounds(input: CompactAuthWindowTransitionBoundsInput): CompactAuthRectangle;
export declare function compactAuthWindowTransitionProgress(progress: number): number;
export declare function leaveCompactAuthFullScreen(
  window: CompactAuthFullScreenWindow,
  platform?: CompactAuthPlatform,
): Promise<void>;
export declare function leaveCompactAuthMaximized(
  window: CompactAuthMaximizedWindow,
  platform?: CompactAuthPlatform,
): Promise<void>;
export declare function compactAuthWindowHtml(input?: CompactAuthWindowHtmlInput): string;
