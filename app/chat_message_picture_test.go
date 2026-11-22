package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/egoist/mygo/ui"
)

// A user message carries its attachments as metadata with the image bytes stripped: the server
// keeps name, type and size so the transcript stays small, and serves the bytes from
// GET /api/messages/{id}/attachments/{index}. The app has to read that list, which it did not -
// a picture sent from the composer was invisible in the chat afterwards.
const userMessageWithPicture = `{
  "attachments": [
    {"name": "粘贴的图片.png", "type": "image/png", "size": 1234},
    {"name": "notes.md", "type": "text/markdown", "size": 42}
  ]
}`

func TestATranscriptMessageCarriesItsAttachmentList(t *testing.T) {
	var data transcriptMessageData
	if err := json.Unmarshal([]byte(userMessageWithPicture), &data); err != nil {
		t.Fatalf("a message with attachments must parse: %v", err)
	}
	if len(data.Attachments) != 2 {
		t.Fatalf("both attachments are kept, got %d", len(data.Attachments))
	}
	if data.Attachments[0].Type != "image/png" {
		t.Fatalf("the image attachment keeps its type, got %q", data.Attachments[0].Type)
	}
	if data.Attachments[0].Name != "粘贴的图片.png" {
		t.Fatalf("the image attachment keeps its name, got %q", data.Attachments[0].Name)
	}
}

// onlyImages is what the bubble shows: a text attachment was sent as text and is already in the
// message body, so drawing it as a picture would show it twice.
func TestOnlyImageAttachmentsAreDrawn(t *testing.T) {
	// The daemon serves the bytes; the test serves one picture for the image attachment and
	// nothing for the text one.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/messages/m1/attachments/0" {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes(t))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	chat := &chatState{
		api: newAPIClient(server.URL, ""),
		messages: []transcriptMessage{{
			ID: "m1", Role: "user", Kind: "chat", Text: "看这张图",
			Data: transcriptMessageData{Attachments: []transcriptAttachment{
				{Name: "a.png", Type: "image/png", Size: 10},
				{Name: "notes.md", Type: "text/markdown", Size: 42},
			}},
		}},
	}
	chat.loadAttachmentPictures()
	tester := ui.NewTester(chat.view, 900, 700)
	frames(tester)

	if chat.pictureCount != 1 {
		t.Fatalf("the image attachment is drawn once and the text one not at all, drew %d", chat.pictureCount)
	}
}

// A picture whose bytes cannot be fetched (an old message, a deleted row, the daemon restarting)
// still shows where it was, and the chat keeps rendering: losing an image must not blank the
// conversation.
func TestAPictureThatCannotBeReadDoesNotBreakTheChat(t *testing.T) {
	chat := &chatState{
		api: newAPIClient("http://127.0.0.1:1", ""),
		messages: []transcriptMessage{{
			ID: "m1", Role: "user", Kind: "chat", Text: "图挂了",
			Data: transcriptMessageData{Attachments: []transcriptAttachment{
				{Name: "gone.png", Type: "image/png", Size: 10},
			}},
		}},
	}
	chat.loadAttachmentPictures()
	tester := ui.NewTester(chat.view, 900, 700)
	frames(tester)

	if !tester.HasText("图挂了") {
		t.Fatalf("the message text still shows when its picture cannot be read, texts %q", tester.Texts())
	}
	if chat.pictureCount != 0 {
		t.Fatalf("no picture is drawn for bytes that cannot be read, drew %d", chat.pictureCount)
	}
}
