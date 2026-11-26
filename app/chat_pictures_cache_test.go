package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"testing"

	"github.com/egoist/mygo/ui"
)

// pictureSourceOfSize builds a decodable picture with a known decoded size, so a test can reason
// about bytes held rather than about how well a PNG compressed.
func pictureSourceOfSize(t *testing.T, width, height int) ui.ImageSource {
	t.Helper()
	source, err := ui.DecodeImage(pngOfSize(t, width, height))
	if err != nil {
		t.Fatalf("decode a %dx%d picture: %v", width, height, err)
	}
	return source
}

// A cache has to hold a bounded amount of decoded pixels. Before this, every picture a
// conversation ever showed stayed decoded for as long as the window was open: 60 screenshots at
// 2560x1600 is about 938MB of pixels, whatever their PNG size.
func TestThePictureCacheStaysUnderItsLimit(t *testing.T) {
	cache := &pictureCache{}
	// Four pictures of 64x64 RGBA = 16KB each; the limit holds three of them.
	cache.limit = 3 * pictureBytes(pictureSourceOfSize(t, 64, 64))
	for index := 0; index < 4; index++ {
		cache.put(fmt.Sprintf("m%d", index), 0, pictureSourceOfSize(t, 64, 64))
	}
	if held := cache.heldBytes(); held > cache.limit {
		t.Fatalf("the cache holds %d bytes against a limit of %d", held, cache.limit)
	}
	if len(cache.sources) > 3 {
		t.Fatalf("the cache keeps at most three pictures, got %d", len(cache.sources))
	}
}

// The picture dropped first is the one used least recently, so scrolling back up to a picture
// someone is reading does not throw away the one they just looked at.
func TestThePictureCacheDropsTheLeastRecentlyUsedFirst(t *testing.T) {
	cache := &pictureCache{}
	cache.limit = 2 * pictureBytes(pictureSourceOfSize(t, 64, 64))
	cache.put("a", 0, pictureSourceOfSize(t, 64, 64))
	cache.put("b", 0, pictureSourceOfSize(t, 64, 64))
	// Read "a", so "b" becomes the least recently used.
	if _, loaded, _ := cache.get("a", 0); !loaded {
		t.Fatalf("a picture just stored is there")
	}
	cache.put("c", 0, pictureSourceOfSize(t, 64, 64))

	if _, loaded, _ := cache.get("b", 0); loaded {
		t.Fatalf("the least recently used picture is the one dropped")
	}
	for _, key := range []string{"a", "c"} {
		if _, loaded, _ := cache.get(key, 0); !loaded {
			t.Fatalf("the recently used and the newest pictures stay, %s was dropped", key)
		}
	}
}

// A picture bigger than the whole limit is not cached - but it must still be drawable, so a
// single large screenshot does not become invisible.
func TestAPictureBiggerThanTheLimitIsStillDrawn(t *testing.T) {
	cache := &pictureCache{}
	cache.limit = pictureBytes(pictureSourceOfSize(t, 8, 8))
	big := pictureSourceOfSize(t, 128, 128)
	cache.put("big", 0, big)

	if held := cache.heldBytes(); held > cache.limit {
		t.Fatalf("an oversized picture is not held in the cache, held %d against %d", held, cache.limit)
	}
	// The frame that decoded it draws it from the value it already has, which is why an
	// oversized picture still shows even though the cache refused to keep it.
	chat := &chatState{}
	// One frame, counted from zero: this asserts the picture is drawn, not how many frames the
	// tester settles.
	chat.pictureCount = 0
	tester := newTester(func(ctx *ui.Context) {
		chat.pictureCount = 0
		chat.drawPicture(ctx, big)
	}, 600, 400)
	frames(tester)
	if chat.pictureCount != 1 {
		t.Fatalf("the picture it just decoded is drawn anyway, drew %d", chat.pictureCount)
	}
}

// The failure list is the same kind of unbounded map as the sources: a long conversation with
// many unreadable pictures must not grow it without end either.
func TestTheFailedPictureListIsBounded(t *testing.T) {
	cache := &pictureCache{}
	for index := 0; index < pictureFailedLimit+50; index++ {
		cache.putFailed(fmt.Sprintf("m%d", index), 0)
	}
	if len(cache.failed) > pictureFailedLimit {
		t.Fatalf("the failed list holds at most %d entries, got %d", pictureFailedLimit, len(cache.failed))
	}
}

// Replacing a key must not count its bytes twice, or the cache would shrink as pictures are
// reloaded and evict everything else for no reason.
func TestReplacingAPictureDoesNotCountItTwice(t *testing.T) {
	cache := &pictureCache{}
	cache.limit = 10 * pictureBytes(pictureSourceOfSize(t, 64, 64))
	one := pictureSourceOfSize(t, 64, 64)
	cache.put("a", 0, one)
	first := cache.heldBytes()
	cache.put("a", 0, one)
	if second := cache.heldBytes(); second != first {
		t.Fatalf("storing the same picture twice holds %d bytes, was %d", second, first)
	}
}

// The bytes a source costs are its decoded pixels, not its encoded file: a 2560x1600 screenshot
// is about 15.6MB of RGBA however small its PNG is.
func TestPictureBytesCountDecodedPixels(t *testing.T) {
	source := pictureSourceOfSize(t, 256, 160)
	want := 256 * 160 * 4
	if got := pictureBytes(source); got != want {
		t.Fatalf("a 256x160 picture costs %d bytes of pixels, got %d", want, got)
	}
}

// pngOfSize encodes a solid picture of the given size, which is what the daemon serves.
func pngOfSize(t *testing.T, width, height int) []byte {
	t.Helper()
	return encodeSolidPNG(t, width, height)
}

// encodeSolidPNG is a PNG of the requested size: the fixtures here exist to have a known decoded
// size, which a screenshot of arbitrary content would not give.
func encodeSolidPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			picture.Set(x, y, color.RGBA{R: 200, G: 60, B: 60, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, picture); err != nil {
		t.Fatalf("encode a %dx%d fixture: %v", width, height, err)
	}
	return buf.Bytes()
}
