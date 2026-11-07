const PRIVATE_TAG = '(?:analysis|review[\\s_]*of[\\s_]*last[\\s_]*turn)';
const PAIRED = new RegExp(`<(${PRIVATE_TAG})>[\\s\\S]*?<\\/\\1>`, 'gi');
const OPEN_TAIL = new RegExp(`<${PRIVATE_TAG}>[\\s\\S]*$`, 'i');
const CLOSING = new RegExp(`<\\/${PRIVATE_TAG}>`, 'gi');
const OPENING = new RegExp(`<${PRIVATE_TAG}>`, 'i');

export function assistantVisibleText(text: string): string {
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map(part => {
    if (part.startsWith('```') || part.startsWith('~~~')) return part;
    return part.replace(PAIRED, '').replace(OPEN_TAIL, '').replace(CLOSING, '');
  }).join('');
}
