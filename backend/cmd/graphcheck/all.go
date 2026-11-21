package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func runAll(root string) int {
	steps := [][]string{
		{"go", "-C", "backend", "run", "./cmd/graphbuild", "backend"},
		{"go", "-C", "backend", "vet", "./..."},
		{"go", "-C", "backend", "test", "./..."},
		{"go", "-C", "app", "vet", "./..."},
		{"go", "-C", "app", "test", "./..."},
	}
	for _, step := range steps {
		fmt.Printf("[check] %s\n", strings.Join(step, " "))
		command := exec.Command(step[0], step[1:]...)
		command.Dir = root
		command.Stdout = os.Stdout
		command.Stderr = os.Stderr
		if err := command.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "[check] failed: %s\n", strings.Join(step, " "))
			return 1
		}
	}
	if code := runComments(root, nil); code != 0 {
		return code
	}
	if code := runTokens(root, []string{"--changed"}); code != 0 {
		return code
	}
	if code := runOwnership(root, nil); code != 0 {
		return code
	}
	if code := runAPI(root); code != 0 {
		return code
	}
	if code := runMachines(root, nil); code != 0 {
		return code
	}
	if code := runHarness(root, nil); code != 0 {
		return code
	}
	if code := runEvidence(root); code != 0 {
		return code
	}
	if code := runProse(root, nil); code != 0 {
		return code
	}
	if code := runProse(root, []string{"--staged"}); code != 0 {
		return code
	}
	if code := runFeatureMap(root, nil); code != 0 {
		return code
	}
	if code := runSoftRules(root, nil); code != 0 {
		return code
	}
	fmt.Println("[check] ok")
	return 0
}
