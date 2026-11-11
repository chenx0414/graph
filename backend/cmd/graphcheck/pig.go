package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/pigpin"
)

type pigOptions struct {
	mode           string
	version        string
	allowDowngrade bool
	root           string
}

func runPig(repoRoot string, arguments []string) int {
	options, ok := parsePigArguments(repoRoot, arguments)
	if !ok {
		return 1
	}
	if options.mode == "help" {
		fmt.Println("usage: graphcheck pig [--check] [--set <version|latest>] [--allow-downgrade] [--root <dir>]")
		return 0
	}
	moduleDir := filepath.Join(options.root, "backend")
	goModPath := filepath.Join(moduleDir, "go.mod")
	goSumPath := filepath.Join(moduleDir, "go.sum")
	goMod, err := os.ReadFile(goModPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pig kernel update failed: no Go module at %s\n", goModPath)
		return 1
	}
	current, _ := pigpin.PinnedVersion(goMod)
	needsLatest := options.mode != "set" || options.version == "latest"
	latest := ""
	if needsLatest {
		versions, listErr := publishedVersions(moduleDir)
		if listErr != nil {
			if options.mode == "set" {
				fmt.Fprintf(os.Stderr, "pig kernel update failed: %v\n", listErr)
				return 1
			}
			fmt.Printf("pinned:  %s\nlatest:  (unavailable)\nmodule:  %s\nskipped: the module proxy is unreachable\nreason:  %v\n", pinLabel(current), pigpin.Module, listErr)
			return 0
		}
		stable, stableOK := pigpin.LatestStable(versions)
		if !stableOK {
			if options.mode == "set" {
				fmt.Fprintf(os.Stderr, "pig kernel update failed: no published version of %s was found\n", pigpin.Module)
				return 1
			}
			fmt.Printf("pinned:  %s\nlatest:  (unavailable)\nmodule:  %s\nskipped: the module proxy is unreachable\nreason:  no published version of %s was found\n", pinLabel(current), pigpin.Module, pigpin.Module)
			return 0
		}
		latest = stable
	}
	switch options.mode {
	case "report":
		fmt.Printf("pinned:  %s\nlatest:  %s\nmodule:  %s\n", pinLabel(current), latest, pigpin.Module)
		return 0
	case "check":
		fmt.Printf("pinned:  %s\nlatest:  %s\n", pinLabel(current), latest)
		if current == latest {
			return 0
		}
		fmt.Fprintf(os.Stderr, "the pinned kernel %s is behind the published %s; run: go -C backend run ./cmd/graphcheck pig --set latest\n", pinLabel(current), latest)
		return 1
	}
	return applyPin(options, moduleDir, goModPath, goSumPath, goMod, current, latest)
}

func applyPin(options pigOptions, moduleDir, goModPath, goSumPath string, goMod []byte, current, latest string) int {
	target := options.version
	if target == "latest" {
		target = latest
	}
	if !pigpin.IsVersion(target) {
		fmt.Fprintf(os.Stderr, "pig kernel update failed: %s is not a kernel version\n", target)
		return 1
	}
	if current != "" && target == current {
		fmt.Printf("the kernel is already pinned at %s\n", current)
		return 0
	}
	if current != "" && pigpin.CompareVersions(target, current) < 0 && !options.allowDowngrade {
		fmt.Fprintf(os.Stderr, "pig kernel update failed: %s is older than the pinned %s; pass --allow-downgrade to move back\n", target, current)
		return 1
	}
	goSum, _ := os.ReadFile(goSumPath)
	fail := func(message string) int {
		if writeErr := os.WriteFile(goModPath, goMod, 0o644); writeErr != nil {
			fmt.Fprintf(os.Stderr, "pig kernel update failed: could not restore %s: %v\n", goModPath, writeErr)
			return 1
		}
		if len(goSum) > 0 {
			if writeErr := os.WriteFile(goSumPath, goSum, 0o644); writeErr != nil {
				fmt.Fprintf(os.Stderr, "pig kernel update failed: could not restore %s: %v\n", goSumPath, writeErr)
				return 1
			}
		}
		fmt.Fprintf(os.Stderr, "pig kernel update failed: %s\nthe pinned kernel was left at %s.\n", message, pinLabel(current))
		return 1
	}
	if output, ok := runGo(moduleDir, "list", "-m", pigpin.Module+"@"+target); !ok {
		return fail(pigpin.Module + " " + target + " is not a published version: " + output)
	}
	rewritten, err := pigpin.WritePin(goMod, target)
	if err != nil {
		return fail(err.Error())
	}
	if err := os.WriteFile(goModPath, rewritten, 0o644); err != nil {
		return fail(err.Error())
	}
	if output, ok := runGo(moduleDir, "mod", "tidy"); !ok {
		return fail("go mod tidy failed:\n" + output)
	}
	applied, _ := pigpin.PinnedVersion(mustRead(goModPath))
	if applied != target {
		return fail("the module graph pinned " + pinLabel(applied) + " instead of the requested " + target)
	}
	if output, ok := runGo(moduleDir, "build", "./..."); !ok {
		return fail("the backend does not build against " + target + ":\n" + output)
	}
	fmt.Printf("the kernel is pinned at %s and the backend builds against it.\n", target)
	return 0
}

func parsePigArguments(repoRoot string, arguments []string) (pigOptions, bool) {
	options := pigOptions{mode: "report", root: repoRoot}
	for index := 0; index < len(arguments); index++ {
		switch arguments[index] {
		case "--check":
			options.mode = "check"
		case "--set":
			options.mode = "set"
			index++
			options.version = valueAt(arguments, index)
		case "--allow-downgrade":
			options.allowDowngrade = true
		case "--root":
			index++
			options.root = valueAt(arguments, index)
		case "--help", "-h":
			options.mode = "help"
		default:
			fmt.Fprintf(os.Stderr, "pig kernel update failed: unknown argument %s\n", arguments[index])
			return options, false
		}
	}
	if options.mode == "set" && options.version == "" {
		fmt.Fprintln(os.Stderr, "pig kernel update failed: --set needs a version, or the word latest")
		return options, false
	}
	if options.root == "" {
		fmt.Fprintln(os.Stderr, "pig kernel update failed: --root needs a directory")
		return options, false
	}
	return options, true
}

func publishedVersions(moduleDir string) ([]string, error) {
	output, ok := runGo(moduleDir, "list", "-m", "-versions", pigpin.Module)
	if !ok {
		return nil, fmt.Errorf("go list -m -versions failed: %s", output)
	}
	return pigpin.ParseVersions(output), nil
}

func runGo(moduleDir string, arguments ...string) (string, bool) {
	command := exec.Command("go", arguments...)
	command.Dir = moduleDir
	stdout, stderr := &strings.Builder{}, &strings.Builder{}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	text := strings.TrimSpace(stderr.String())
	if text == "" {
		text = strings.TrimSpace(stdout.String())
	}
	return text, err == nil
}

func mustRead(path string) []byte {
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return payload
}

func pinLabel(version string) string {
	if version == "" {
		return "(not pinned)"
	}
	return version
}
