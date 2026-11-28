package main

import (
	"strconv"
	"time"
)

func runActive(run transcriptRun) bool {
	for _, message := range run.messages {
		if messageActive(message) {
			return true
		}
	}
	return false
}

const runClockWindow = 24 * time.Hour

func runElapsed(run transcriptRun, now time.Time) (time.Duration, bool) {
	if len(run.messages) == 0 {
		return 0, false
	}
	start := run.messages[0].CreatedAt
	if start <= 0 {
		return 0, false
	}
	began := time.UnixMilli(start)
	end := now
	if runActive(run) {
		if now.Sub(began) > runClockWindow {
			return 0, false
		}
	} else {
		last := run.messages[len(run.messages)-1].CreatedAt
		for _, message := range run.messages {
			if message.UpdatedAt > last {
				last = message.UpdatedAt
			}
		}
		if last <= start {
			return 0, false
		}
		end = time.UnixMilli(last)
	}
	elapsed := end.Sub(began)
	if elapsed < 0 {
		return 0, true
	}
	return elapsed, true
}

func codexWorkedFor(elapsed time.Duration) string {
	seconds := int64(elapsed / time.Second)
	if seconds <= 0 {
		seconds = 1
	}
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	rest := seconds % 60
	switch {
	case hours > 0:
		return strconv.FormatInt(hours, 10) + "h " + strconv.FormatInt(minutes, 10) + "m"
	case minutes > 0:
		return strconv.FormatInt(minutes, 10) + "m " + strconv.FormatInt(rest, 10) + "s"
	}
	return strconv.FormatInt(rest, 10) + "s"
}
