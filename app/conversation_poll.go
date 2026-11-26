package main

import (
	"crypto/sha256"
	"encoding/hex"
)

func transcriptFingerprint(messages []transcriptMessage) string {
	digest := sha256.New()
	for _, message := range messages {
		digest.Write([]byte(message.ID))
		digest.Write([]byte{0})
		digest.Write([]byte(message.State))
		digest.Write([]byte{0})
		digest.Write([]byte(message.Text))
		if draft := message.Data.VerificationDraft; draft != nil && draft.Confirmed {
			digest.Write([]byte{2})
		}
		digest.Write([]byte{1})
	}
	return hex.EncodeToString(digest.Sum(nil))
}

func (c *chatState) poll() bool {
	source := readShell(c.window, func() agentChatSource {
		if c.active != "" && c.api.address != "" {
			return c.source
		}
		return nil
	})
	if source == nil {
		return false
	}
	changed, err := source.Refresh(c)
	return err == nil && changed
}
