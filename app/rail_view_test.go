package main

import (
	"testing"
)

func TestTheRailNoLongerOffersHistoryOrConversationPages(t *testing.T) {
	if len(railItems) != 6 {
		t.Fatalf("the rail keeps six module entries, got %d", len(railItems))
	}
	providers := false
	assemblies := false
	for _, item := range railItems {
		if item.kind == "providers" {
			providers = true
		}
		if item.kind == "assemblies" {
			assemblies = true
		}
	}
	if !providers {
		t.Fatal("the rail offers the providers page")
	}
	if !assemblies {
		t.Fatal("the rail offers the assembly page")
	}
	for _, item := range railItems {
		if item.kind == "graph" {
			t.Fatal("the rail no longer offers the graph canvas")
		}
		if item.kind == "history" || item.kind == "conversation" || item.kind == "overview" || item.kind == "insights" {
			t.Fatalf("the rail still offers %q", item.kind)
		}
	}
}
