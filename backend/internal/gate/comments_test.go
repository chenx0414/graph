package gate

import "testing"

func TestScanCommentsCountsDirectivesAndProse(t *testing.T) {
	for _, test := range []struct {
		name        string
		source      string
		lang        string
		directive   int
		explanatory int
	}{
		{"a line comment is one explanatory", "// hello\nx := 1\n", "go", 0, 1},
		{"a directive line is a directive", "//go:build linux\nx := 1\n", "go", 1, 0},
		{"a graph marker is a directive", "// graph:allow-large-file: generated\n", "go", 1, 0},
		{"two prose lines are two", "// one\n// two\n", "go", 0, 2},
		{"a block comment counts its height", "/*\n one\n two\n*/\n", "go", 0, 4},
		{"a directive block counts its height", "/*\ngraph:table-writes-exempt: migration\n*/\n", "go", 3, 0},
		{"a slash inside a string is not a comment", "u := \"http://example.test\"\n", "go", 0, 0},
		{"an escaped quote does not end the string", "u := \"a\\\"//b\"\n", "go", 0, 0},
		{"a backtick string holds slashes", "q := `SELECT 1 // not a comment`\n", "go", 0, 0},
		{"an unterminated block still counts", "/*\n open\n", "go", 0, 3},
		{"ts text is scanned the same way", "// one\nconst a = '//'\n", "ts", 0, 1},
	} {
		counts := ScanComments(test.source, test.lang)
		if counts.Directive != test.directive || counts.Explanatory != test.explanatory {
			t.Fatalf("%s: directive %d explanatory %d, want %d/%d", test.name, counts.Directive, counts.Explanatory, test.directive, test.explanatory)
		}
	}
}

func TestCompareExplanatoryReportsOnlyAdditions(t *testing.T) {
	before := "// one\nx := 1\n"
	if CompareExplanatory(before, before, "go") {
		t.Fatal("an unchanged file must not report an added comment")
	}
	if CompareExplanatory("// old prose\nx := 1\n", "// new prose\nx := 1\n", "go") {
		t.Fatal("a rewrite that keeps the same prose count is not an addition")
	}
	if !CompareExplanatory("x := 1\n", "// one\n// two\nx := 1\n", "go") {
		t.Fatal("a file that gains explanatory comments must report an addition")
	}
}

func TestScanRepoSkipsTestsAndVendoredTrees(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "backend/a.go", "// prose\npackage a\n")
	writeFile(t, root, "backend/a_test.go", "// one\n// two\n// three\n")
	writeFile(t, root, "backend/node_modules/v/x.go", "// one\n// two\n")
	files := ScanRepo(root)
	if len(files) != 1 || files[0].Path != "backend/a.go" {
		t.Fatalf("only the package source may be scanned, got %+v", files)
	}
	if files[0].Explanatory != 1 {
		t.Fatalf("the scanned file has %d explanatory comments", files[0].Explanatory)
	}
}
