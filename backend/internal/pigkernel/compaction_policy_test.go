package pigkernel

import "testing"

func TestCompactionPolicyForScalesWithTheContextWindow(t *testing.T) {
	cases := []struct {
		window      int
		wantReserve int
		wantKeep    int
	}{
		{window: 200000, wantReserve: 60000, wantKeep: 20000},
		{window: 32000, wantReserve: 9600, wantKeep: 8000},
		{window: 8000, wantReserve: 2400, wantKeep: 2000},
		{window: 2000, wantReserve: 1000, wantKeep: 1024},
		{window: 1000, wantReserve: 500, wantKeep: 1024},
	}
	for _, c := range cases {
		reserve, keep := CompactionPolicyFor(c.window)
		if reserve != c.wantReserve || keep != c.wantKeep {
			t.Fatalf("window %d: got reserve=%d keep=%d, want reserve=%d keep=%d",
				c.window, reserve, keep, c.wantReserve, c.wantKeep)
		}
	}
}
