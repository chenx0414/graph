/** Remove private analysis that a provider emitted as ordinary assistant text.
 * Fenced examples remain visible because they are user-facing documentation. */
export function assistantVisibleText(text: string): string {
  return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map(part => {
    if (part.startsWith('```') || part.startsWith('~~~')) return part;
    return part.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
      .replace(/<analysis>[\s\S]*$/i, '')
      .replace(/<\/analysis>/gi, '');
  }).join('');
}
