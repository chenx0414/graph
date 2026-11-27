package main

import (
	"fmt"
	"os"

	"github.com/chenx0414/graph/backend/internal/appinstall"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(appinstall.ExitUsage)
	}
	root, err := repoRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphbuild: %v\n", err)
		os.Exit(appinstall.ExitUsage)
	}
	switch os.Args[1] {
	case "backend":
		path, buildErr := appinstall.BuildBackend(root, hasFlag(os.Args[2:], "--if-missing"))
		if buildErr != nil {
			fmt.Fprintf(os.Stderr, "[graph] %v\n", buildErr)
			os.Exit(1)
		}
		fmt.Printf("[graph] backend ready: %s\n", path)
	case "app":
		if buildErr := appinstall.PackageApp(root, func(line string) { fmt.Println(line) }); buildErr != nil {
			fmt.Fprintf(os.Stderr, "[app-mygo] %v\n", buildErr)
			os.Exit(1)
		}
	case "install":
		options, parseErr := parseInstall(root, os.Args[2:])
		if parseErr != nil {
			fmt.Fprintf(os.Stderr, "%v\n", parseErr)
			os.Exit(appinstall.ExitUsage)
		}
		message, installErr := appinstall.Install(options)
		if installErr != nil {
			fmt.Fprintln(os.Stderr, installErr.Error())
			os.Exit(appinstall.ExitCode(installErr))
		}
		fmt.Println(message)
	case "sign":
		if len(os.Args) < 3 {
			usage()
			os.Exit(appinstall.ExitUsage)
		}
		if signErr := appinstall.SignCode(os.Args[2], appinstall.SignOptions{Identifier: appinstall.CodeIdentifier}); signErr != nil {
			fmt.Fprintf(os.Stderr, "sign: %v\n", signErr)
			os.Exit(appinstall.ExitSignFailed)
		}
		printed, printErr := appinstall.DesignatedRequirement(os.Args[2])
		if printErr != nil {
			fmt.Fprintf(os.Stderr, "sign: %v\n", printErr)
			os.Exit(appinstall.ExitSignFailed)
		}
		fmt.Println(printed)
	default:
		usage()
		os.Exit(appinstall.ExitUsage)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: graphbuild backend [--if-missing] | app | install [--bundle P] [--dest P] [--dry-run] | sign <path>")
}

func hasFlag(args []string, flag string) bool {
	for _, argument := range args {
		if argument == flag {
			return true
		}
	}
	return false
}

func flagValue(args []string, name string) string {
	for index, argument := range args {
		if argument == "--"+name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

func parseInstall(root string, args []string) (appinstall.InstallOptions, error) {
	options := appinstall.InstallOptions{Root: root, DryRun: hasFlag(args, "--dry-run")}
	if custom := flagValue(args, "root"); custom != "" {
		options.Root = custom
	}
	if bundle := flagValue(args, "bundle"); bundle != "" {
		options.Bundle = bundle
	}
	if dest := flagValue(args, "dest"); dest != "" {
		options.Dest = dest
	}
	if options.Bundle == "" {
		options.Bundle = appinstall.DefaultBundle(options.Root)
	}
	if stateDir := flagValue(args, "state-dir"); stateDir != "" {
		options.StateDir = stateDir
	}
	if options.Dest == "" {
		options.Dest = appinstall.DefaultDest()
	}
	if options.StateDir == "" {
		options.StateDir = appinstall.DefaultStateDir()
	}
	return options, nil
}

func repoRoot() (string, error) {
	return appinstall.RepoRoot()
}
