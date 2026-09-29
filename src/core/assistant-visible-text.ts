// These are private response dialect markers observed in ordinary provider text.
// Keep one definition for stream recovery and transcript rendering.
const PRIVATE_TAG = '(?:analysis|review[\\s_]*of[\\s_]*last[\\s_]*turn)';
const PAIRED = new RegExp(`<(${PRIVATE_TAG})>[\\s\\S]*?<\\/\\1>`, 'gi');
const OPEN_TAIL = new RegExp(`<${PRIVATE_TAG}>[\\s\\S]*$`, 'i');
const CLOSING = new RegExp(`<\\/${PRIVATE_TAG}>`, 'gi');
const OPENING = new RegExp(`<${PRIVATE_TAG}>`, 'i');

/** Whether ordinary text contains an internal marker outside fenced examples. */
export function hasPrivateMarkup(text: string): boolean {
  return OPENING.test(text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ''));
}

/** Remove private markup emitted as ordinary assistant text. Fenced examples stay visible. */
export function assistantVisibleText(text: string): string {
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map(part => {
    if (part.startsWith('```') || part.startsWith('~~~')) return part;
    return part.replace(PAIRED, '').replace(OPEN_TAIL, '').replace(CLOSING, '');
  }).join('');
}
