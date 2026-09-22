import type { ImageContent } from '@earendil-works/pi-ai';

/**
 * Build the options object for Pi's `AgentSession.prompt(text, options?)`.
 *
 * The SDK signature is `prompt(text: string, options?: PromptOptions)` and
 * image attachments must travel inside `options.images`; passing the raw
 * `ImageContent[]` as the second argument would silently drop them. A prompt
 * without images passes no options at all, exactly like the SDK default.
 */
export function sdkPromptOptions(images: ImageContent[] | undefined): { images: ImageContent[] } | undefined {
  return images && images.length > 0 ? { images } : undefined;
}
