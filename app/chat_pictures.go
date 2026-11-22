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

// pictureCache holds decoded pictures by the message and index they came from. The bytes are
// served by the daemon, and a picture that was read once is drawn from here on each frame
// instead of being downloaded again.
type pictureCache struct {
	mu      sync.Mutex
	sources map[string]ui.ImageSource
	failed  map[string]bool
}

func (cache *pictureCache) key(messageID string, index int) string {
	return fmt.Sprintf("%s#%d", messageID, index)
}

func (cache *pictureCache) get(messageID string, index int) (ui.ImageSource, bool, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	key := cache.key(messageID, index)
	if source, ok := cache.sources[key]; ok {
		return source, true, false
	}
	return nil, false, cache.failed[key]
}

func (cache *pictureCache) put(messageID string, index int, source ui.ImageSource) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.sources == nil {
		cache.sources = map[string]ui.ImageSource{}
	}
	cache.sources[cache.key(messageID, index)] = source
}

func (cache *pictureCache) putFailed(messageID string, index int) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.failed == nil {
		cache.failed = map[string]bool{}
	}
	cache.failed[cache.key(messageID, index)] = true
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

// messagePicture draws one sent picture, at a size that fits the bubble. It reports whether a
// picture was drawn.
func (c *chatState) messagePicture(ctx *ui.Context, messageID string, index int) bool {
	source, loaded, _ := c.pictures.get(messageID, index)
	if !loaded || source == nil {
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
