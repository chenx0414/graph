package main

import "testing"

func statusSnapshot(units ...fleetAgent) *fleetSnapshot {
	return &fleetSnapshot{
		RootID: "g1",
		Agents: append([]fleetAgent{
			{ID: "g1", Kind: "global", Status: "running"},
			{ID: "p1", ParentID: "g1", Kind: "project", ProjectID: "proj", Status: "running"},
		}, units...),
	}
}

func TestTerminalGraphUnitsDoNotOutrankRunningOnes(t *testing.T) {
	data := statusSnapshot(
		fleetAgent{ID: "n-run", ParentID: "p1", Kind: "node", TaskID: "t-run", Status: "running", UpdatedAt: 100},
		fleetAgent{ID: "n-fail", ParentID: "p1", Kind: "node", TaskID: "t-fail", Status: "failed", UpdatedAt: 200},
	)
	units := fleetGraphUnits(data)
	if len(units) != 1 || units[0].TaskID != "t-run" {
		t.Fatalf("a running graph is the current one while a failed one is terminal, got %+v", units)
	}
}

func TestEveryTerminalStatusEndsItsGraphUnit(t *testing.T) {
	for _, status := range []string{"done", "completed", "succeeded", "failed", "stopped", "abandoned"} {
		data := statusSnapshot(
			fleetAgent{ID: "n-run", ParentID: "p1", Kind: "node", TaskID: "t-run", Status: "running", UpdatedAt: 100},
			fleetAgent{ID: "n-end", ParentID: "p1", Kind: "node", TaskID: "t-end", Status: status, UpdatedAt: 200},
		)
		units := fleetGraphUnits(data)
		if len(units) != 1 || units[0].TaskID != "t-run" {
			t.Fatalf("status %q must be terminal, got %+v", status, units)
		}
	}
}

func TestGraphUnitsPrefersTheNewestTerminalWhenNothingRuns(t *testing.T) {
	data := statusSnapshot(
		fleetAgent{ID: "n-done", ParentID: "p1", Kind: "node", TaskID: "t-done", Status: "done", UpdatedAt: 100},
		fleetAgent{ID: "n-fail", ParentID: "p1", Kind: "node", TaskID: "t-fail", Status: "failed", UpdatedAt: 200},
	)
	units := fleetGraphUnits(data)
	if len(units) != 1 || units[0].TaskID != "t-fail" {
		t.Fatalf("the newest terminal graph is the one to show, got %+v", units)
	}
}
