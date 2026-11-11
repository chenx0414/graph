package pigpin

import "testing"

const pinnedGoMod = `module github.com/chenx0414/graph/backend

go 1.24

require (
	github.com/MichaelKinsy/PiG v0.5.3
	github.com/mattn/go-sqlite3 v1.14.22
)

require github.com/MichaelKinsy/PiG/extensions/sdk v0.5.3 // indirect
`

func TestPinnedVersionReadsTheRequireBlock(t *testing.T) {
	version, ok := PinnedVersion([]byte(pinnedGoMod))
	if !ok || version != "v0.5.3" {
		t.Fatalf("version = %q, ok = %v", version, ok)
	}
}

func TestPinnedVersionReadsASingleRequireLine(t *testing.T) {
	version, ok := PinnedVersion([]byte("module example\n\nrequire github.com/MichaelKinsy/PiG v0.4.9\n"))
	if !ok || version != "v0.4.9" {
		t.Fatalf("version = %q, ok = %v", version, ok)
	}
}

func TestPinnedVersionIgnoresTheSDKModule(t *testing.T) {
	version, _ := PinnedVersion([]byte("module example\n\nrequire github.com/MichaelKinsy/PiG/extensions/sdk v9.9.9 // indirect\n"))
	if version != "" {
		t.Fatalf("version = %q, want the kernel module left alone", version)
	}
}

func TestWritePinKeepsTheRestOfTheFile(t *testing.T) {
	rewritten, err := WritePin([]byte(pinnedGoMod), "v0.6.0")
	if err != nil {
		t.Fatalf("write pin: %v", err)
	}
	want := `module github.com/chenx0414/graph/backend

go 1.24

require (
	github.com/MichaelKinsy/PiG v0.6.0
	github.com/mattn/go-sqlite3 v1.14.22
)

require github.com/MichaelKinsy/PiG/extensions/sdk v0.5.3 // indirect
`
	if string(rewritten) != want {
		t.Fatalf("rewritten =\n%s\nwant\n%s", rewritten, want)
	}
	if version, _ := PinnedVersion(rewritten); version != "v0.6.0" {
		t.Fatalf("version = %q after rewrite", version)
	}
}

func TestWritePinAddsARequirementWhenNoneIsPinned(t *testing.T) {
	rewritten, err := WritePin([]byte("module example\n\ngo 1.24\n"), "v0.6.0")
	if err != nil {
		t.Fatalf("write pin: %v", err)
	}
	if string(rewritten) != "module example\n\nrequire github.com/MichaelKinsy/PiG v0.6.0\n\ngo 1.24\n" {
		t.Fatalf("rewritten = %q", rewritten)
	}
}

func TestWritePinRefusesAFileWithoutAModuleLine(t *testing.T) {
	if _, err := WritePin([]byte("go 1.24\n"), "v0.6.0"); err == nil {
		t.Fatal("want an error for a file without a module line")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"v0.5.3", "v0.5.3", 0},
		{"v0.6.0", "v0.5.3", 1},
		{"v0.5.3", "v0.6.0", -1},
		{"v1.0.0", "v0.9.9", 1},
		{"v0.5.3", "v0.5.3-rc1", 1},
		{"v0.5.3-rc1", "v0.5.3", -1},
		{"v0.5.3-alpha", "v0.5.3-beta", -1},
	}
	for _, testCase := range cases {
		if got := CompareVersions(testCase.left, testCase.right); got != testCase.want {
			t.Errorf("compare(%s, %s) = %d, want %d", testCase.left, testCase.right, got, testCase.want)
		}
	}
}

func TestLatestStableSkipsPrereleases(t *testing.T) {
	versions := ParseVersions("github.com/MichaelKinsy/PiG v0.4.0 v0.5.3 v0.6.0-rc1\n")
	latest, ok := LatestStable(versions)
	if !ok || latest != "v0.5.3" {
		t.Fatalf("latest = %q, ok = %v", latest, ok)
	}
	onlyPrereleases, _ := LatestStable([]string{"v0.1.0-rc1", "v0.1.0-rc2"})
	if onlyPrereleases != "v0.1.0-rc2" {
		t.Fatalf("latest = %q when every version is a prerelease", onlyPrereleases)
	}
}

func TestIsVersion(t *testing.T) {
	for _, value := range []string{"v0.5.3", "v1.0.0", "v0.6.0-rc1"} {
		if !IsVersion(value) {
			t.Errorf("%s should be accepted", value)
		}
	}
	for _, value := range []string{"0.5.3", "latest", "v1.2", ""} {
		if IsVersion(value) {
			t.Errorf("%s should be rejected", value)
		}
	}
}
