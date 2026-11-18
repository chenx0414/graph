package main

import (
	"testing"
	"time"
)

// TestRelativeTimeLabelCoversCalendarBoundaries checks the user-visible label
// for every rule: today is time only, the two preceding days are named, the
// current year keeps month and day, and an older year carries the year.
func TestRelativeTimeLabelCoversCalendarBoundaries(t *testing.T) {
	now := time.Date(2026, time.August, 16, 15, 4, 0, 0, time.Local)
	cases := []struct {
		name string
		at   time.Time
		want string
	}{
		{"today morning", time.Date(2026, time.August, 16, 9, 5, 0, 0, time.Local), "09:05"},
		{"today same moment", now, "15:04"},
		{"yesterday", time.Date(2026, time.August, 15, 15, 4, 0, 0, time.Local), "昨天 15:04"},
		{"day before yesterday", time.Date(2026, time.August, 14, 15, 4, 0, 0, time.Local), "前天 15:04"},
		{"earlier this year", time.Date(2026, time.August, 1, 15, 4, 0, 0, time.Local), "8月1日 15:04"},
		{"earlier this year two digit month", time.Date(2026, time.November, 14, 15, 4, 0, 0, time.Local), "11月14日 15:04"},
		{"last year", time.Date(2025, time.December, 31, 15, 4, 0, 0, time.Local), "2025年12月31日 15:04"},
		{"next year future", time.Date(2027, time.January, 2, 15, 4, 0, 0, time.Local), "2027年1月2日 15:04"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := relativeTimeLabel(tc.at, now); got != tc.want {
				t.Fatalf("relativeTimeLabel(%s, %s) = %q, want %q", tc.at, now, got, tc.want)
			}
		})
	}
}

// TestRelativeTimeLabelHandlesZeroAndFuture guards the fallback for absent
// timestamps: they render as an empty label, not a made-up date.
func TestRelativeTimeLabelHandlesZeroAndFuture(t *testing.T) {
	now := time.Date(2026, time.August, 16, 15, 4, 0, 0, time.Local)
	if got := relativeTimeLabel(time.Time{}, now); got != "" {
		t.Fatalf("zero time should be empty, got %q", got)
	}
	if got := relativeTimeFromMillis(0, now); got != "" {
		t.Fatalf("zero millis should be empty, got %q", got)
	}
}

// TestRelativeTimeLabelSurvivesDaylightSaving checks that a calendar day is
// counted by dates, not by 24 hour spans. A spring forward day is only 23 hours
// long, so an hours based difference would call yesterday "today".
func TestRelativeTimeLabelSurvivesDaylightSaving(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("time zone data unavailable: %v", err)
	}
	// 2026-03-08 is the spring forward (23 hour) day; 2026-11-01 is the fall
	// back (25 hour) day. In both cases the previous calendar date is 昨天.
	for _, now := range []time.Time{
		time.Date(2026, time.March, 9, 15, 4, 0, 0, loc),
		time.Date(2026, time.November, 2, 15, 4, 0, 0, loc),
	} {
		at := now.AddDate(0, 0, -1)
		if got, want := relativeTimeLabel(at, now), "昨天 15:04"; got != want {
			t.Fatalf("relativeTimeLabel(%s, %s) = %q, want %q", at, now, got, want)
		}
		before := now.AddDate(0, 0, -2)
		if got, want := relativeTimeLabel(before, now), "前天 15:04"; got != want {
			t.Fatalf("relativeTimeLabel(%s, %s) = %q, want %q", before, now, got, want)
		}
	}
}

// TestMessageClockAtMatchesCalendarRules ties the milliseconds entry point to
// the same shared function used by collab events and message bubbles.
func TestMessageClockAtMatchesCalendarRules(t *testing.T) {
	now := time.Date(2026, time.August, 16, 15, 4, 0, 0, time.Local)
	stamp := time.Date(2026, time.August, 15, 15, 4, 0, 0, time.Local).UnixMilli()
	if got, want := relativeTimeFromMillis(stamp, now), "昨天 15:04"; got != want {
		t.Fatalf("yesterday millis = %q, want %q", got, want)
	}
}
