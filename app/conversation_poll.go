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
	if c.active == "" || c.api.address == "" {
		return false
	}
	payload, err := c.api.get("/api/conversations/" + c.active)
	if err != nil {
		return false
	}
	messages, err := parseConversationMessages(payload)
	if err != nil {
		return false
	}
	fingerprint := transcriptFingerprint(messages)
	body, bodyErr := parseConversationBody(payload)
	changed := fingerprint != c.fingerprint
	if bodyErr == nil {
		if body.Paused != c.paused || len(body.Questions) != len(c.questions) {
			changed = true
		}
	}
	if !changed {
		return false
	}
	c.fingerprint = fingerprint
	c.messages = messages
	if bodyErr == nil {
		c.paused = body.Paused
		c.questions = nil
		for _, question := range body.Questions {
			if question.open() {
				c.questions = append(c.questions, question)
			}
		}
	}
	if rows, err := parseGraphTasks(payload); err == nil {
		c.tasks = rows
	}
	return true
}
