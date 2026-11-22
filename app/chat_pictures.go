package main

import (
	"bytes"
	"fmt"
	"sync"

	gwtheme "graph/app/gwui/theme"

	"github.com/egoist/mygo/ui"
)

// messagePictureSize is the largest a sent picture is drawn on screen: enough to recognise it,
// small enough that a screenshot does not push the rest of the conversation off the view.
const messagePictureWidth = 260

// pictureCacheBytes bounds how many decoded pixels one conversation keeps in memory. A decoded
// screenshot costs about its width*height*4, so this holds roughly eight 2560x1600 screenshots:
// enough that scrolling a normal conversation never re-reads a picture, small enough that a long
// one cannot grow the window to gigabytes.
const pictureCacheBytes = 128 * 1024 * 1024

// pictureFailedLimit bounds the list of pictures that could not be read. It is the same kind of
// map as sources and would otherwise grow with every unreadable picture in a long conversation.
const pictureFailedLimit = 256

// pictureBytes is what a decoded picture costs: its pixels in RGBA, not the size of the file it
// came from. A 2560x1600 screenshot is about 15.6MB here however small its PNG is.
func pictureBytes(source ui.ImageSource) int {
	width, height := ui.ImageSize(source)
	if width <= 0 || height <= 0 {
		return 0
	}
	return int(width) * int(height) * 4
}

// pictureCache holds decoded pictures by the message and index they came from. The bytes are
// served by the daemon, and a picture that was read once is drawn from here on each frame
// instead of being downloaded again - within a byte budget, dropping the least recently used
// picture first so scrolling back up keeps what someone is reading.
type pictureCache struct {
	mu      sync.Mutex
	sources map[string]ui.ImageSource
	failed  map[string]bool
	// used orders the keys by last use, oldest first; the head is dropped first.
	used []string
	held int
	// limit is the byte budget; zero means pictureCacheBytes. A test sets a small one.
	limit int
}

// budget is the byte limit this cache works to.
func (cache *pictureCache) budget() int {
	if cache.limit > 0 {
		return cache.limit
	}
	return pictureCacheBytes
}

// heldBytes is how much decoded pixel data the cache is holding now.
func (cache *pictureCache) heldBytes() int {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return cache.held
}

// touch moves a key to the newest position in the use order.
func (cache *pictureCache) touch(key string) {
	for index, existing := range cache.used {
		if existing == key {
			cache.used = append(cache.used[:index], cache.used[index+1:]...)
			break
		}
	}
	cache.used = append(cache.used, key)
}

// evict drops the oldest pictures until the cache fits its budget.
func (cache *pictureCache) evict() {
	for cache.held > cache.budget() && len(cache.used) > 0 {
		oldest := cache.used[0]
		cache.used = cache.used[1:]
		if source, ok := cache.sources[oldest]; ok {
			cache.held -= pictureBytes(source)
			delete(cache.sources, oldest)
		}
	}
}

func (cache *pictureCache) key(messageID string, index int) string {
	return fmt.Sprintf("%s#%d", messageID, index)
}

func (cache *pictureCache) get(messageID string, index int) (ui.ImageSource, bool, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	key := cache.key(messageID, index)
	if source, ok := cache.sources[key]; ok {
		cache.touch(key)
		return source, true, false
	}
	return nil, false, cache.failed[key]
}

// put keeps a decoded picture within the budget. A picture that cannot fit at all is not
// remembered: the caller still draws the one it just decoded, and the next frame reads it again,
// which is the only way to show a picture larger than the whole budget.
func (cache *pictureCache) put(messageID string, index int, source ui.ImageSource) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.sources == nil {
		cache.sources = map[string]ui.ImageSource{}
	}
	key := cache.key(messageID, index)
	cost := pictureBytes(source)
	if cost <= 0 || cost > cache.budget() {
		if existing, ok := cache.sources[key]; ok {
			cache.held -= pictureBytes(existing)
			delete(cache.sources, key)
		}
		return
	}
	if existing, ok := cache.sources[key]; ok {
		cache.held -= pictureBytes(existing)
	}
	cache.sources[key] = source
	cache.held += cost
	cache.touch(key)
	delete(cache.failed, key)
	cache.evict()
}

// putFailed remembers a picture that could not be read, so it is not retried every frame. The
// list is bounded: once it is full the oldest entry is forgotten and may be retried, which is
// better than a map that grows with every unreadable picture in a long conversation.
func (cache *pictureCache) putFailed(messageID string, index int) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.failed == nil {
		cache.failed = map[string]bool{}
	}
	key := cache.key(messageID, index)
	if cache.failed[key] {
		return
	}
	if len(cache.failed) >= pictureFailedLimit {
		for oldest := range cache.failed {
			delete(cache.failed, oldest)
			break
		}
	}
	cache.failed[key] = true
}

// loadAttachmentPictures reads and decodes the picture behind every image attachment in the
// transcript, so the next frame draws it. A picture that cannot be read is remembered as failed
// and left out: one missing picture must not stop the conversation from rendering.
func (c *chatState) loadAttachmentPictures() {
	for _, message := range c.messages {
		for index, attachment := range message.Data.Attachments {
			if !attachment.isImage() {
				continue
			}
			if _, loaded, failed := c.pictures.get(message.ID, index); loaded || failed {
				continue
			}
			raw, err := c.api.get(messageAttachmentPath(message.ID, index))
			if err != nil {
				c.pictures.putFailed(message.ID, index)
				continue
			}
			source, err := ui.DecodeImage(bytes.TrimSpace(raw))
			if err != nil {
				c.pictures.putFailed(message.ID, index)
				continue
			}
			c.pictures.put(message.ID, index, source)
		}
	}
}

func messageAttachmentPath(messageID string, index int) string {
	return fmt.Sprintf("/api/messages/%s/attachments/%d", messageID, index)
}

// messagePicture draws the cached picture of an attachment, reporting whether it drew one.
func (c *chatState) messagePicture(ctx *ui.Context, messageID string, index int) bool {
	source, loaded, _ := c.pictures.get(messageID, index)
	if !loaded {
		return false
	}
	return c.drawPicture(ctx, source)
}

// drawPicture draws one decoded picture, at a size that fits the bubble. It reports whether a
// picture was drawn. The picture is passed in rather than looked up, so the frame that decoded a
// picture too large to cache can still show it.
func (c *chatState) drawPicture(ctx *ui.Context, source ui.ImageSource) bool {
	if source == nil {
		return false
	}
	c.pictureCount++
	width, height := ui.ImageSize(source)
	if width <= 0 || height <= 0 {
		return false
	}
	// Keep the aspect ratio: a pasted screenshot is wider than it is tall, and squashing it
	// would make it unrecognisable.
	shownWidth := float32(messagePictureWidth)
	if width < shownWidth {
		shownWidth = width
	}
	shownHeight := shownWidth * height / width
	t := gwtheme.Of(ctx)
	ui.Image(ctx, source).Width(shownWidth).Height(shownHeight).Radius(t.Radius.Lg)
	return true
}
