/**
 * Stable per-seat display identity.
 *
 * The room's four seats are anonymous and their pseudonyms come from a closed
 * server-assigned set. Giving each seat a stable hue is a comprehension aid,
 * not decoration: the same colour marks the avatar in the transcript, the
 * mention chip in the composer, and the node in the interaction network, so a
 * student can see that the person who spoke is the person in the graph.
 *
 * The hue is derived from the pseudonym only. It carries no ranking, no score
 * and no identity beyond the seat, and it is never the sole channel for any
 * state — every colour-coded element also carries text.
 */

const SEAT_HUES = ["var(--who-a)", "var(--who-b)", "var(--who-c)", "var(--who-d)"] as const;

/** Trailing seat letter of a server pseudonym such as 「探索者 B」. */
function seatIndex(pseudonym: string): number | undefined {
  const letter = pseudonym.trim().slice(-1).toUpperCase();
  const index = letter.charCodeAt(0) - "A".charCodeAt(0);
  return index >= 0 && index < SEAT_HUES.length ? index : undefined;
}

export function identityHue(
  pseudonym: string,
  actorKind: "human" | "agent" = "human",
): string {
  if (actorKind === "agent") return "var(--who-nova)";
  const index = seatIndex(pseudonym);
  return index === undefined ? "var(--who-fallback)" : SEAT_HUES[index]!;
}

/** Inline custom property consumed by `--who` in globals.css. */
export function identityStyle(
  pseudonym: string,
  actorKind: "human" | "agent" = "human",
): Readonly<Record<string, string>> {
  return { "--who": identityHue(pseudonym, actorKind) };
}

/** One or two display characters for a seat avatar. */
export function identityInitial(pseudonym: string): string {
  const trimmed = pseudonym.trim();
  if (!trimmed) return "?";
  const seat = seatIndex(trimmed);
  return seat === undefined ? trimmed.slice(0, 1) : trimmed.slice(-1).toUpperCase();
}
