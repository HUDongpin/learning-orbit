import React from "react";

/**
 * The one boundary through which classroom-authored text reaches the DOM.
 *
 * React escapes markup already, so this is not about script tags: it is about
 * the characters that survive escaping and still change what a reader sees.
 * A right-to-left override reverses the rest of a line, so a message can be
 * made to read as something its author did not write. Invisible characters
 * hide content inside apparently short text. An unbounded combining sequence
 * paints over neighbouring rows. And a chat message is also the input to an
 * Agent prompt, so text impersonating a system instruction has to be visible
 * as text rather than blend in.
 *
 * Nothing here rewrites meaning. It removes characters that carry no meaning
 * for a reader, bounds what one grapheme may stack, and marks what remains as
 * data.
 */

/** Bidirectional formatting characters, which reorder text after escaping. */
const BIDI_CONTROLS = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{061C}\u{200E}\u{200F}]/gu;
/** Zero-width and other invisible separators used to hide content. */
const INVISIBLES = /[\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{00AD}\u{180E}]/gu;
/** C0/C1 controls, except the newline and tab a classroom message may contain. */
const CONTROLS = /[\u{0000}-\u{0008}\u{000B}\u{000C}\u{000E}-\u{001F}\u{007F}-\u{009F}]/gu;
/** More than this many combining marks on one base is a rendering attack. */
const MAX_COMBINING_MARKS = 8;
const COMBINING = /\p{Mn}|\p{Me}/u;

/**
 * Strip what cannot be displayed honestly and bound what can.
 *
 * Deliberately not an escape function: escaping is React's job, and doing it
 * twice would show a reader the entity where they wrote the character.
 */
export function sanitizeUntrustedText(value: unknown): string {
  if (typeof value !== "string") return "";
  const stripped = value
    .replace(BIDI_CONTROLS, "")
    .replace(INVISIBLES, "")
    .replace(CONTROLS, "");
  let output = "";
  let combining = 0;
  for (const character of stripped) {
    if (COMBINING.test(character)) {
      combining += 1;
      if (combining > MAX_COMBINING_MARKS) continue;
    } else {
      combining = 0;
    }
    output += character;
  }
  return output;
}

/** True when text tries to look like an instruction rather than a message. */
const IMPERSONATION = /^\s*(?:system|assistant|nova|指令|系統)\s*[:：]/iu;

export function looksLikeImpersonatedInstruction(value: string): boolean {
  return IMPERSONATION.test(value);
}

export interface UntrustedTextProps {
  readonly value: unknown;
  /** Rendered element; a span by default so it inherits the surrounding style. */
  readonly as?: "span" | "p" | "div";
  readonly className?: string;
  /** Longest text this surface will show before it is cut with an ellipsis. */
  readonly maxLength?: number;
}

/**
 * Render classroom-authored text as data.
 *
 * `dir="auto"` lets a genuinely right-to-left message display correctly while
 * the isolation stops it reordering anything around it - the honest version of
 * what the stripped override characters were being used to fake.
 */
export function UntrustedText({
  value,
  as: Element = "span",
  className,
  maxLength,
}: UntrustedTextProps): React.ReactElement {
  const sanitized = sanitizeUntrustedText(value);
  const bounded = typeof maxLength === "number" && maxLength > 0 && sanitized.length > maxLength
    ? `${sanitized.slice(0, maxLength)}…`
    : sanitized;
  return (
    <Element
      className={className}
      dir="auto"
      data-untrusted="true"
      {...(looksLikeImpersonatedInstruction(bounded) ? { "data-impersonation": "true" } : {})}
      style={{ unicodeBidi: "isolate" }}
    >
      {bounded}
    </Element>
  );
}
