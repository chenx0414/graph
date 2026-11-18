package main

import (
	"strconv"
	"time"
)

// relativeTimeLabel formats a timestamp the way the chat, collaboration card
// and other timelines read it: the time alone for today, a named day for the
// two days before today, a month and day for older dates in this year, and a
// full year for anything outside it. An empty label means there is no real
// timestamp to show; callers never invent a date for missing data.
func relativeTimeLabel(at, now time.Time) string {
	if at.IsZero() {
		return ""
	}
	nowYear, nowMonth, nowDay := now.Date()
	atLocal := at.In(now.Location())
	atYear, atMonth, atDay := atLocal.Date()
	clock := atLocal.Format("15:04")

	// Count calendar days by date, not by 24 hour spans: a daylight saving
	// transition makes a day 23 or 25 hours long without changing its name.
	nowDate := time.Date(nowYear, nowMonth, nowDay, 0, 0, 0, 0, now.Location())
	atDate := time.Date(atYear, atMonth, atDay, 0, 0, 0, 0, now.Location())
	days := 0
	for d := nowDate; d.After(atDate); d = d.AddDate(0, 0, -1) {
		days++
	}
	for d := nowDate; d.Before(atDate); d = d.AddDate(0, 0, 1) {
		days--
	}
	switch days {
	case 0:
		return clock
	case 1:
		return "昨天 " + clock
	case 2:
		return "前天 " + clock
	}
	if atLocal.Year() != now.Year() {
		return strconv.Itoa(atLocal.Year()) + "年" + strconv.Itoa(int(atLocal.Month())) + "月" + strconv.Itoa(atLocal.Day()) + "日 " + clock
	}
	return strconv.Itoa(int(atLocal.Month())) + "月" + strconv.Itoa(atLocal.Day()) + "日 " + clock
}

// relativeTimeFromMillis is the milliseconds entry point shared by message
// bubbles and collaboration events.
func relativeTimeFromMillis(millis int64, now time.Time) string {
	if millis <= 0 {
		return ""
	}
	return relativeTimeLabel(time.UnixMilli(millis), now)
}
