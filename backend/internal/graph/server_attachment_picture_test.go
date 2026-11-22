// graph:table-writes-exempt: the test seeds the message it reads the picture back from
package graph

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// The app draws a sent picture by fetching its bytes from the daemon, because a transcript
// carries only the attachment metadata. This walks that whole path: a message sent with an image
// attachment, listed without its bytes, then read back byte for byte.
func TestASentPictureIsReadBackFromTheMessageItBelongsTo(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/pictures','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','r',1)")
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c','p','t','Main',1,0,'global')`)
	app := CreateApp(&TaskRuntime{store: store, kernel: NewKernelStore(store)}, AppOptions{})

	picture := []byte("\x89PNG\r\n\x1a\n a pasted screenshot")
	encoded := base64.StdEncoding.EncodeToString(picture)
	body, err := json.Marshal(map[string]any{
		"text":      "看这张图",
		"requestId": "picture-test-1",
		"attachments": []any{map[string]any{
			"name": "粘贴的图片.png", "type": "image/png", "size": len(picture), "data": encoded,
		}},
	})
	if err != nil {
		t.Fatalf("build the send: %v", err)
	}
	send := httptest.NewRequest(http.MethodPost, "/api/conversations/c/messages", bytes.NewReader(body))
	send.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
	send.Header.Set("Origin", "http://127.0.0.1:1")
	sent := httptest.NewRecorder()
	app.ServeHTTP(sent, send)
	if sent.Code != http.StatusOK {
		t.Fatalf("a message with an image attachment is accepted, got %d: %s", sent.Code, sent.Body.String())
	}

	// The message the app renders must name its attachment without carrying the bytes.
	list := httptest.NewRequest(http.MethodGet, "/api/conversations/c", nil)
	list.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
	listed := httptest.NewRecorder()
	app.ServeHTTP(listed, list)
	var conversation map[string]any
	if err := json.Unmarshal(listed.Body.Bytes(), &conversation); err != nil {
		t.Fatalf("read the conversation: %v", err)
	}
	var sentID string
	var sentBody map[string]any
	if err := json.Unmarshal(sent.Body.Bytes(), &sentBody); err == nil {
		sentID, _ = sentBody["messageId"].(string)
	}
	messages, _ := conversation["messages"].([]any)
	var message map[string]any
	for _, candidate := range messages {
		record, _ := candidate.(map[string]any)
		if id, _ := record["id"].(string); id != "" && id == sentID {
			message = record
			break
		}
	}
	if message == nil {
		t.Fatalf("the sent message %q is in the conversation, got %d messages", sentID, len(messages))
	}
	messageID := sentID
	data, _ := message["data"].(map[string]any)
	attachments, _ := data["attachments"].([]any)
	if len(attachments) != 1 {
		t.Fatalf("the message names its one attachment, got %d", len(attachments))
	}
	attachment := attachments[0].(map[string]any)
	if attachment["type"] != "image/png" {
		t.Fatalf("the attachment keeps its type, got %v", attachment["type"])
	}
	if _, carries := attachment["data"]; carries {
		t.Fatalf("a transcript carries no image bytes, got %+v", attachment)
	}

	// The bytes the app draws come from here, in the shape it decodes.
	fetch := httptest.NewRequest(http.MethodGet, "/api/messages/"+messageID+"/attachments/0", nil)
	fetch.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
	fetched := httptest.NewRecorder()
	app.ServeHTTP(fetched, fetch)
	if fetched.Code != http.StatusOK {
		t.Fatalf("the picture is served, got %d: %s", fetched.Code, fetched.Body.String())
	}
	if !bytes.Equal(fetched.Body.Bytes(), picture) {
		t.Fatalf("the served picture is the one that was sent, got %d bytes", fetched.Body.Len())
	}
	if kind := fetched.Header().Get("Content-Type"); kind != "image/png" {
		t.Fatalf("the picture is served as its type, got %q", kind)
	}
}

// A message that has no such attachment answers not-found, which the app treats as a picture it
// cannot draw rather than an error that empties the conversation.
func TestAnAttachmentThatIsNotThereIsNotFound(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	app := CreateApp(&TaskRuntime{store: store, kernel: NewKernelStore(store)}, AppOptions{})
	request := httptest.NewRequest(http.MethodGet, "/api/messages/missing/attachments/0", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: app.session})
	recorder := httptest.NewRecorder()
	app.ServeHTTP(recorder, request)
	if recorder.Code == http.StatusOK {
		t.Fatalf("a missing attachment is not answered as a picture, got %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "not_found") {
		t.Fatalf("a missing attachment answers not_found, got %d: %s", recorder.Code, recorder.Body.String())
	}
}
