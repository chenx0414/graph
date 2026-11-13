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
		digest.Write([]byte{1})
	}
	return hex.EncodeToString(digest.Sum(nil))
}

func (c *chatState) poll() bool {
	var source agentChatSource
	onUI(c.window, func() {
		if c.active != "" && c.api.address != "" {
			source = c.source
		}
	})
	if source == nil {
		return false
	}
	changed, err := source.Refresh(c)
	return err == nil && changed
}
