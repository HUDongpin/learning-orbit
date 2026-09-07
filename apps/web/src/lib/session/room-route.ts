const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

export function roomPagePath(roomId: string, role: "student" | "teacher"): string {
  if (!isRoomId(roomId)) throw new Error("INVALID_ROOM_ID");
  return `/session/${roomId}${role === "teacher" ? "/teacher" : ""}`;
}

/** The TRACE window a viewer is looking at. */
export const ROOM_VIEW_WINDOWS = ["recent_10m", "session_45m"] as const;
/** The TRACE view a viewer is looking at. */
export const ROOM_VIEW_NAMES = ["observed", "human_only", "lineage_adjusted"] as const;

export type RoomViewWindow = (typeof ROOM_VIEW_WINDOWS)[number];
export type RoomViewName = (typeof ROOM_VIEW_NAMES)[number];

export interface RoomViewPreferences {
  readonly window: RoomViewWindow;
  readonly view: RoomViewName;
}

export const DEFAULT_ROOM_VIEW: RoomViewPreferences = Object.freeze({
  window: "recent_10m",
  view: "observed",
});

/**
 * Read the view selections out of a query string.
 *
 * These belong in the URL rather than in component state: a reload, a restored
 * tab or a link a teacher pastes to a colleague should land on the same view,
 * and browser storage is not available to this product for anything. Anything
 * unrecognised falls back to the default rather than throwing - a mistyped
 * query must never be able to break the classroom.
 */
export function parseRoomViewPreferences(
  search: string | URLSearchParams | null | undefined,
): RoomViewPreferences {
  const params = typeof search === "string"
    ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
    : search ?? new URLSearchParams();
  const window = params.get("window");
  const view = params.get("view");
  return Object.freeze({
    window: ROOM_VIEW_WINDOWS.includes(window as RoomViewWindow)
      ? window as RoomViewWindow
      : DEFAULT_ROOM_VIEW.window,
    view: ROOM_VIEW_NAMES.includes(view as RoomViewName)
      ? view as RoomViewName
      : DEFAULT_ROOM_VIEW.view,
  });
}

/**
 * Render the selections back into a query string, omitting defaults so an
 * untouched classroom keeps a clean URL.
 */
export function roomViewSearch(
  preferences: RoomViewPreferences,
  base?: string | URLSearchParams | null,
): string {
  const params = typeof base === "string"
    ? new URLSearchParams(base.startsWith("?") ? base.slice(1) : base)
    : new URLSearchParams(base ?? undefined);
  for (const [key, value, fallback] of [
    ["window", preferences.window, DEFAULT_ROOM_VIEW.window],
    ["view", preferences.view, DEFAULT_ROOM_VIEW.view],
  ] as const) {
    if (value === fallback) params.delete(key);
    else params.set(key, value);
  }
  params.sort();
  return params.toString();
}
