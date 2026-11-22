package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
)

// pngBytes is a small solid-red PNG, the shape a screenshot pasted from the system clipboard
// has: real encoded bytes, not a placeholder string.
func pngBytes(t *testing.T) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for x := 0; x < 8; x++ {
		for y := 0; y < 8; y++ {
			picture.Set(x, y, color.RGBA{R: 220, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, picture); err != nil {
		t.Fatalf("encode the fixture picture: %v", err)
	}
	return buf.Bytes()
}

// The clipboard is the only source a paste has, so the test hands the window a clipboard that
// holds a picture and no text - which is what a copied screenshot looks like.
type pictureClipboard struct {
	picture []byte
	text    string
}

func (c *pictureClipboard) Formats() []transfer.Format {
	formats := []transfer.Format{}
	if len(c.picture) > 0 {
		formats = append(formats, transfer.PNG)
	}
	if c.text != "" {
		formats = append(formats, transfer.Text)
	}
	return formats
}

func (c *pictureClipboard) ReadText() string { return c.text }

func (c *pictureClipboard) WriteText(string) {}

func (c *pictureClipboard) Read(formats ...transfer.Format) (transfer.Data, error) {
	items := []transfer.Item{}
	for _, format := range formats {
		switch format {
		case transfer.PNG:
			if len(c.picture) > 0 {
				items = append(items, transfer.NewItem(transfer.Bytes(transfer.PNG, c.picture)))
			}
		case transfer.Text:
			if c.text != "" {
				items = append(items, transfer.NewItem(transfer.Bytes(transfer.Text, []byte(c.text))))
			}
		}
	}
	if len(items) == 0 {
		return transfer.Data{}, transfer.ErrFormat
	}
	return transfer.New(items...), nil
}

// A pasted picture becomes an image attachment, with the same shape the attachment picker
// produces, so sending it needs no second path.
func TestPastingAPictureAttachesItAsAnImage(t *testing.T) {
	chat := &chatState{draft: "", source: &conversationChatSource{id: "c1"}}
	chat.clipboard = &pictureClipboard{picture: pngBytes(t)}

	if !chat.handleComposerPaste(nil, "") {
		t.Fatalf("a paste whose clipboard holds a picture must be taken by the composer")
	}
	if len(chat.attachments) != 1 {
		t.Fatalf("the pasted picture becomes one attachment, got %d", len(chat.attachments))
	}
	attachment := chat.attachments[0]
	if !attachment.isImage() {
		t.Fatalf("the attachment must be an image carrying its bytes, got type %q and %d bytes",
			attachment.Type, len(attachment.Data))
	}
	if _, err := base64.StdEncoding.DecodeString(attachment.Data); err != nil {
		t.Fatalf("the attachment keeps the picture base64 encoded as the sender expects: %v", err)
	}
	if attachment.Size <= 0 {
		t.Fatalf("the attachment carries its size, got %d", attachment.Size)
	}
}

// Text still pastes as text: the picture path must not swallow an ordinary paste.
func TestPastingTextStillInsertsText(t *testing.T) {
	chat := &chatState{draft: ""}
	chat.clipboard = &pictureClipboard{text: "一段普通文字"}
	tester := ui.NewTester(chat.composer, 900, 260)
	frames(tester)

	if chat.handleComposerPaste(nil, "一段普通文字") {
		t.Fatalf("a text paste must be left to the input, not taken by the picture path")
	}
	if len(chat.attachments) != 0 {
		t.Fatalf("a text paste attaches nothing, got %d attachments", len(chat.attachments))
	}
}

// A clipboard holding a picture and text (a copied cell, an image with a caption) pastes the
// picture: the picture is what the picker cannot already do.
func TestPastingAPictureWithTextTakesThePicture(t *testing.T) {
	chat := &chatState{draft: ""}
	chat.clipboard = &pictureClipboard{picture: pngBytes(t), text: "caption"}
	tester := ui.NewTester(chat.composer, 900, 260)
	frames(tester)

	if !chat.handleComposerPaste(nil, "caption") {
		t.Fatalf("a clipboard holding a picture pastes the picture even when it also carries text")
	}
	if len(chat.attachments) != 1 || !chat.attachments[0].isImage() {
		t.Fatalf("the picture is attached, got %d attachments", len(chat.attachments))
	}
}

// An empty clipboard, or a paste with no clipboard at all, changes nothing and does not panic.
func TestPastingAnEmptyClipboardAttachesNothing(t *testing.T) {
	chat := &chatState{draft: ""}
	chat.clipboard = &pictureClipboard{}
	tester := ui.NewTester(chat.composer, 900, 260)
	frames(tester)

	if chat.handleComposerPaste(nil, "") {
		t.Fatalf("an empty clipboard leaves the paste to the input")
	}
	if len(chat.attachments) != 0 {
		t.Fatalf("an empty clipboard attaches nothing, got %d", len(chat.attachments))
	}
}

// A picture too large to send is refused with a visible reason, not silently attached.
func TestPastingAPictureOverTheLimitIsRefused(t *testing.T) {
	chat := &chatState{draft: ""}
	// composerImageLimit bytes of picture is already over the limit once encoded.
	chat.clipboard = &pictureClipboard{picture: make([]byte, composerImageLimit+1)}
	tester := ui.NewTester(chat.composer, 900, 260)
	frames(tester)

	chat.handleComposerPaste(nil, "")
	if len(chat.attachments) != 0 {
		t.Fatalf("a picture over the limit is not attached, got %d", len(chat.attachments))
	}
	if chat.status == "" {
		t.Fatalf("a refused paste says why, status is empty")
	}
}

// The paste has to reach the composer through the input, not only through a direct call: the
// first version of this change called handleComposerPaste in its tests and would have passed
// even with no OnPaste wired, which is exactly the bug being fixed. This presses Cmd+V.
func TestCmdVPastesAPictureThroughTheInput(t *testing.T) {
	chat := &chatState{draft: "", source: &conversationChatSource{id: "c1"}}
	chat.clipboard = &pictureClipboard{picture: pngBytes(t)}
	tester := ui.NewTester(chat.composer, 900, 260)
	frames(tester)

	// Focus the composer the way the user does, then paste. The injected clipboard answers the
	// picture read; the window's clipboard is what the input itself would insert.
	if err := tester.Click("消息"); err != nil {
		t.Fatalf("focus the composer: %v", err)
	}
	tester.SetClipboard("")
	tester.Key(ui.Cmd, ui.KeyV)
	frames(tester)

	if len(chat.attachments) != 1 || !chat.attachments[0].isImage() {
		t.Fatalf("Cmd+V with a picture on the clipboard attaches it, got %d attachments", len(chat.attachments))
	}
	if chat.draft != "" {
		t.Fatalf("a taken paste inserts no text, the draft is %q", chat.draft)
	}
}

// A text paste still reaches the input: the picture path must not eat everything.
func TestCmdVPastesTextIntoTheDraft(t *testing.T) {
	chat := &chatState{draft: "", source: &conversationChatSource{id: "c1"}}
	chat.clipboard = &pictureClipboard{text: "粘贴的文字"}
	tester := ui.NewTester(chat.composer, 900, 260)
	frames(tester)

	if err := tester.Click("消息"); err != nil {
		t.Fatalf("focus the composer: %v", err)
	}
	// The editor inserts a pasted text through the window's clipboard, so the window's
	// clipboard is what carries the words; the injected one only answers "no picture here".
	tester.SetClipboard("粘贴的文字")
	tester.Key(ui.Cmd, ui.KeyV)
	frames(tester)

	if chat.draft != "粘贴的文字" {
		t.Fatalf("a text paste lands in the draft, got %q", chat.draft)
	}
	if len(chat.attachments) != 0 {
		t.Fatalf("a text paste attaches nothing, got %d", len(chat.attachments))
	}
}

// A pathClipboard is the clipboard a picture copied in Finder has: a file URL or URI list, and
// no picture bytes at all. Measured on macOS: selecting a screenshot and pressing Cmd+C puts a
// file reference on the clipboard, not an image/png representation.
type pathClipboard struct {
	paths []string
	text  string
}

func (c *pathClipboard) Files() []clipboardFile {
	files := make([]clipboardFile, 0, len(c.paths))
	for _, path := range c.paths {
		files = append(files, clipboardFile{path: path})
	}
	return files
}

func (c *pathClipboard) Read(formats ...transfer.Format) (transfer.Data, error) {
	items := []transfer.Item{}
	for _, format := range formats {
		switch format {
		case transfer.PNG:
			// no picture representation: exactly what a Finder copy offers
		case transfer.FileList, transfer.URIList:
			if len(c.paths) > 0 {
				data, err := transfer.FileData(c.paths...)
				if err != nil {
					return transfer.Data{}, err
				}
				items = append(items, data.Items()...)
			}
		case transfer.Text:
			if c.text != "" {
				items = append(items, transfer.NewItem(transfer.Bytes(transfer.Text, []byte(c.text))))
			}
		}
	}
	if len(items) == 0 {
		return transfer.Data{}, transfer.ErrFormat
	}
	return transfer.New(items...), nil
}

// A picture file copied in Finder pastes as the picture, not as its name. This is the case the
// user hit: the composer inserted "截屏2026-11-22 16.29.28" and showed no picture.
func TestPastingAPictureFileFromFinderAttachesThePicture(t *testing.T) {
	path := filepath.Join(t.TempDir(), "截屏2026-11-22 16.29.28.png")
	if err := os.WriteFile(path, pngBytes(t), 0o644); err != nil {
		t.Fatalf("write the screenshot fixture: %v", err)
	}
	chat := &chatState{draft: ""}
	chat.clipboard = &pathClipboard{paths: []string{path}}

	if !chat.handleComposerPaste(nil, "截屏2026-11-22 16.29.28") {
		t.Fatalf("a copied picture file is taken by the composer, not inserted as its name")
	}
	if len(chat.attachments) != 1 {
		t.Fatalf("the copied picture becomes one attachment, got %d", len(chat.attachments))
	}
	attachment := chat.attachments[0]
	if !attachment.isImage() {
		t.Fatalf("the attachment is the picture itself, got type %q", attachment.Type)
	}
	if attachment.Name != "截屏2026-11-22 16.29.28.png" {
		t.Fatalf("the attachment keeps the file's own name, got %q", attachment.Name)
	}
}

// A copied text file is attached as a file, not swallowed as if it were a picture.
func TestPastingATextFileFromFinderAttachesTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(path, []byte("# 笔记"), 0o644); err != nil {
		t.Fatalf("write the notes fixture: %v", err)
	}
	chat := &chatState{draft: ""}
	chat.clipboard = &pathClipboard{paths: []string{path}}

	if !chat.handleComposerPaste(nil, "notes.md") {
		t.Fatalf("a copied file is attached rather than pasted as its name")
	}
	if len(chat.attachments) != 1 {
		t.Fatalf("the copied file becomes one attachment, got %d", len(chat.attachments))
	}
	if chat.attachments[0].isImage() {
		t.Fatalf("a markdown file is not an image attachment")
	}
}

// A plan-text name that is not a file stays text: the paste path must not claim every paste.
func TestPastingAPathThatDoesNotExistStaysText(t *testing.T) {
	chat := &chatState{draft: ""}
	chat.clipboard = &pathClipboard{text: "/no/such/截屏2026-11-22.png"}

	if chat.handleComposerPaste(nil, "/no/such/截屏2026-11-22.png") {
		t.Fatalf("a name that is not a readable file is left to the input")
	}
	if len(chat.attachments) != 0 {
		t.Fatalf("nothing is attached for a name that is not a file, got %d", len(chat.attachments))
	}
}
