package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

const composerAttachmentLimit = 512 * 1024

type composerAttachment struct {
	Name string
	Type string
	Size int64
	Text string
	Data string
}

const composerImageLimit = 5 * 1024 * 1024

func composerAttachmentIsImageType(mime string) bool {
	switch mime {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	}
	return false
}

func (a composerAttachment) isImage() bool {
	return a.Data != "" && composerAttachmentIsImageType(a.Type)
}

func composerAttachmentType(name string) string {
	extension := strings.ToLower(filepath.Ext(name))
	switch extension {
	case ".md", ".markdown":
		return "text/markdown"
	case ".json":
		return "application/json"
	case ".go":
		return "text/x-go"
	case ".ts", ".tsx", ".js", ".jsx":
		return "text/javascript"
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return "image/" + strings.TrimPrefix(extension, ".")
	case ".pdf":
		return "application/pdf"
	}
	return "text/plain"
}

func composerAttachmentFromPath(path string) (composerAttachment, error) {
	info, err := os.Stat(path)
	if err != nil {
		return composerAttachment{}, err
	}
	if info.IsDir() {
		return composerAttachment{}, fmt.Errorf("不能附加目录")
	}
	mime := composerAttachmentType(path)
	if composerAttachmentIsImageType(mime) {
		if info.Size() > composerImageLimit {
			return composerAttachment{}, fmt.Errorf("图片超过 5MB")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return composerAttachment{}, err
		}
		return composerAttachment{Name: filepath.Base(path), Type: mime, Size: info.Size(), Data: base64.StdEncoding.EncodeToString(data)}, nil
	}
	if info.Size() > composerAttachmentLimit {
		return composerAttachment{}, fmt.Errorf("文件超过 512KB")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return composerAttachment{}, err
	}
	if !utf8.Valid(data) {
		return composerAttachment{}, fmt.Errorf("只支持文本或图片文件")
	}
	return composerAttachment{Name: filepath.Base(path), Type: mime, Size: info.Size(), Text: string(data)}, nil
}

func (c *chatState) attachFile(path string) {
	go func() {
		attachment, err := composerAttachmentFromPath(path)
		onUI(c.window, func() {
			if err != nil {
				c.status = "附加失败：" + err.Error()
			} else {
				c.attachments = append(c.attachments, attachment)
				c.status = "已附加 " + attachment.Name
			}
			c.frame()
		})
	}()
}

func (c *chatState) pickAttachment() {
	go func() {
		out, err := exec.Command("osascript", "-e", `POSIX path of (choose file with prompt "选择要附加的文件")`).Output()
		path := strings.TrimSpace(string(out))
		if err != nil || path == "" {
			onUI(c.window, func() {
				c.status = "没有选择文件"
				c.frame()
			})
			return
		}
		c.attachFile(path)
	}()
}

func (c *chatState) removeAttachment(index int) {
	if index < 0 || index >= len(c.attachments) {
		return
	}
	c.attachments = append(c.attachments[:index], c.attachments[index+1:]...)
	c.frame()
}

func formatComposerAttachmentSize(size int64) string {
	switch {
	case size >= 1024*1024:
		return fmt.Sprintf("%.1f MB", float64(size)/1024/1024)
	case size >= 1024:
		return fmt.Sprintf("%.1f KB", float64(size)/1024)
	}
	return fmt.Sprintf("%d B", size)
}

func (c *chatState) attachmentStrip(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).Children(func() {
		for index, attachment := range c.attachments {
			current, position := attachment, index
			chip := ui.Row(ctx).Padding(th.Space(1), th.Space(1.5), th.Space(1), th.Space(2)).
				Radius(t.Radius.Md).Background(t.Hover).AlignItems(ui.Center).Gap(th.Space(1.5)).Label(attachment.Name)
			chip.Children(func() {
				c.composerAttachmentGlyph(ctx, current)
				kit.Text(ctx, current.Name, t.Text.Xs).FontWeight(500).SingleLine().Ellipsis("…")
				kit.Text(ctx, formatComposerAttachmentSize(current.Size), t.Text.Xs).TextColor(t.Muted).SingleLine()
				close := ui.Box(ctx).Size(th.Space(4), th.Space(4)).Radius(t.Radius.Full).Center().
					Label("移除附件 " + current.Name).Focusable()
				close.OnClick(func() { c.removeAttachment(position) })
				close.Children(func() {
					ui.Icon(ctx, iconClose).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
				})
			})
		}
	})
}

func (c *chatState) composerAttachmentGlyph(ctx *ui.Context, attachment composerAttachment) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if attachment.isImage() {
		if data, err := base64.StdEncoding.DecodeString(attachment.Data); err == nil {
			if source, err := ui.DecodeImage(data); err == nil {
				ui.Image(ctx, source).Size(th.Space(7), th.Space(7)).Radius(t.Radius.Sm).Clip().
					Label("附件图片 " + attachment.Name)
				return
			}
		}
	}
	ui.Icon(ctx, iconDoc).Size(gwtheme.IconSm, gwtheme.IconSm).TextColor(t.Muted)
}

func (c *chatState) attachmentButton(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	button := ui.Box(ctx).Size(th.Space(7), th.Space(7)).Radius(t.Radius.Md).Center().
		Label("附件").Focusable().Tooltip("附加文件")
	button.OnClick(func() { c.pickAttachment() })
	button.Children(func() {
		ui.Icon(ctx, iconClip).Size(gwtheme.Icon, gwtheme.Icon).TextColor(t.Muted)
	})
}

// systemClipboard is the part of the clipboard this composer reads. A test sets it to a
// clipboard of its own; the composer otherwise reads the window's, through ui.Services.
type systemClipboard interface {
	Read(formats ...transfer.Format) (transfer.Data, error)
}

// windowClipboard reads the clipboard from inside a view build, where the window's own services
// answer without a round trip to the main thread.
type windowClipboard struct{ ctx *ui.Context }

func (c windowClipboard) Read(formats ...transfer.Format) (transfer.Data, error) {
	data := c.ctx.Services().ReadClipboardData(formats...)
	if len(data.Items()) == 0 {
		return data, transfer.ErrFormat
	}
	return data, nil
}

// composerAttachmentFromImage builds the attachment a pasted picture becomes, in exactly the
// shape composerAttachmentFromPath produces for an image file, so sending needs no second path.
func composerAttachmentFromImage(data []byte, mime string) (composerAttachment, error) {
	if len(data) == 0 {
		return composerAttachment{}, fmt.Errorf("剪贴板里没有图片")
	}
	if int64(len(data)) > composerImageLimit {
		return composerAttachment{}, fmt.Errorf("图片超过 5MB")
	}
	if mime == "" {
		mime = "image/png"
	}
	return composerAttachment{
		Name: "粘贴的图片." + strings.TrimPrefix(mime, "image/"),
		Type: mime,
		Size: int64(len(data)),
		Data: base64.StdEncoding.EncodeToString(data),
	}, nil
}

// handleComposerPaste takes a paste before the input inserts it. A clipboard holding a picture
// becomes an image attachment - the attachment picker is the only other way to send a picture,
// and a copied screenshot never has a file to pick. Everything else is left to the input.
//
// It reports whether it took the paste.
func (c *chatState) handleComposerPaste(ctx *ui.Context, text string) bool {
	clipboard := c.clipboard
	if clipboard == nil {
		clipboard = windowClipboard{ctx: ctx}
	}
	if clipboard == nil {
		return false
	}
	data, err := clipboard.Read(transfer.PNG)
	if err != nil || len(data.Items()) == 0 {
		return false
	}
	raw, err := data.Read(transfer.PNG)
	if err != nil || len(raw) == 0 {
		return false
	}
	attachment, err := composerAttachmentFromImage(raw, "image/png")
	if err != nil {
		c.status = "粘贴失败：" + err.Error()
		return true
	}
	c.attachments = append(c.attachments, attachment)
	c.status = "已粘贴 " + attachment.Name
	c.frame()
	return true
}
