package graph

import "strings"

const (
	MAX_ATTACHMENTS                  = 5
	MAX_TEXT_ATTACHMENT_BYTES        = 1_048_576
	MAX_TEXT_ATTACHMENTS_TOTAL_BYTES = 5_242_880
	MAX_IMAGE_ATTACHMENT_BYTES       = 5 * 1024 * 1024
	MAX_MESSAGE_IMAGE_BYTES          = 8 * 1024 * 1024
)

var IMAGE_ATTACHMENT_TYPES = []string{"image/png", "image/jpeg", "image/webp", "image/gif"}

type ImageContent struct {
	Type     string `json:"type"`
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

func IsImageAttachmentType(mime string) bool {
	normalized := strings.ToLower(strings.TrimSpace(mime))
	for _, allowed := range IMAGE_ATTACHMENT_TYPES {
		if allowed == normalized {
			return true
		}
	}
	return false
}

func IsImageAttachment(attachment AttachmentInput) bool {
	return attachment.Data != nil && *attachment.Data != ""
}

func hasBase64Shape(data string) bool {
	if data == "" {
		return true
	}
	padding := 0
	for i := len(data) - 1; i >= 0 && data[i] == '=' && padding < 2; i-- {
		padding++
	}
	body := data[:len(data)-padding]
	for i := 0; i < len(body); i++ {
		c := body[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/') {
			return false
		}
	}
	return true
}

func CleanAttachments(input []AttachmentInput) []AttachmentInput {
	attachments := input
	if attachments == nil {
		attachments = []AttachmentInput{}
	}
	if len(attachments) > MAX_ATTACHMENTS {
		Raise("invalid_input", "A message can contain at most 5 attachments")
	}
	totalText := 0
	totalImage := int64(0)
	cleaned := make([]AttachmentInput, 0, len(attachments))
	for _, attachment := range attachments {
		if strings.TrimSpace(attachment.Name) == "" || len(attachment.Name) > 240 {
			Raise("invalid_input", "Attachment names must be nonempty and bounded")
		}
		if attachment.Type == "" || len(attachment.Type) > 160 {
			Raise("invalid_input", "Attachment "+attachment.Name+" is missing its type")
		}
		name := strings.TrimSpace(attachment.Name)
		if IsImageAttachmentType(attachment.Type) {
			if attachment.Data == nil || strings.TrimSpace(*attachment.Data) == "" {
				Raise("invalid_input", "图片 "+name+" 缺少图片数据")
			}
			if !hasBase64Shape(*attachment.Data) {
				Raise("invalid_input", "图片 "+name+" 不是有效的 base64 数据")
			}
			if !jsSafeInteger(attachment.Size) || attachment.Size < 0 || attachment.Size > MAX_IMAGE_ATTACHMENT_BYTES {
				Raise("invalid_input", "图片 "+name+" 超过单文件 5 MiB 上限")
			}
			if len(*attachment.Data) > (MAX_IMAGE_ATTACHMENT_BYTES*4+2)/3+8 {
				Raise("invalid_input", "图片 "+name+" 超过单文件 5 MiB 上限")
			}
			totalImage += attachment.Size
			if totalImage > MAX_MESSAGE_IMAGE_BYTES {
				Raise("invalid_input", "单条消息的图片总大小超过 8 MiB 上限")
			}
			cleaned = append(cleaned, AttachmentInput{Name: name, Type: strings.ToLower(strings.TrimSpace(attachment.Type)), Size: attachment.Size, Text: "", Data: attachment.Data})
			continue
		}
		if attachment.Data != nil && *attachment.Data != "" {
			Raise("invalid_input", "不支持的附件类型："+attachment.Type)
		}
		bytes := len([]byte(attachment.Text))
		if !jsSafeInteger(attachment.Size) || attachment.Size < 0 || attachment.Size > MAX_TEXT_ATTACHMENT_BYTES || bytes > MAX_TEXT_ATTACHMENT_BYTES {
			Raise("invalid_input", "附件 "+name+" 超过单文件 1 MiB 文本上限")
		}
		totalText += bytes
		if totalText > MAX_TEXT_ATTACHMENTS_TOTAL_BYTES {
			Raise("invalid_input", "文本类附件合计超过 5 MiB 上限")
		}
		if strings.Contains(attachment.Text, "\x00") {
			Raise("invalid_input", "附件 "+name+" 不是文本文件")
		}
		cleaned = append(cleaned, AttachmentInput{Name: name, Type: attachment.Type, Size: attachment.Size, Text: attachment.Text})
	}
	return cleaned
}

func PromptImagesFromAttachments(attachments []AttachmentInput) []ImageContent {
	images := []ImageContent{}
	for _, attachment := range attachments {
		if !IsImageAttachment(attachment) {
			continue
		}
		images = append(images, ImageContent{Type: "image", Data: *attachment.Data, MimeType: attachment.Type})
	}
	return images
}

func StripAttachmentData(data any) any {
	record, ok := data.(map[string]any)
	if !ok || record == nil {
		return data
	}
	items, ok := record["attachments"].([]any)
	if !ok {
		return data
	}
	stripped := make([]any, len(items))
	for i, item := range items {
		entry, ok := item.(map[string]any)
		if !ok || entry == nil {
			stripped[i] = item
			continue
		}
		copy := map[string]any{}
		for key, value := range entry {
			if key == "data" {
				continue
			}
			copy[key] = value
		}
		stripped[i] = copy
	}
	out := map[string]any{}
	for key, value := range record {
		out[key] = value
	}
	out["attachments"] = stripped
	return out
}
