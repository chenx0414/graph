package main

import (
	"bytes"
	"crypto/sha256"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const launchAgentLabel = "dev.graph.daemon"

func stableDaemonPath(paths Paths) string {
	return filepath.Join(filepath.Dir(paths.StateDir), "bin", "graphd")
}

func insideAppBundle(path string) bool {
	return strings.Contains(path, ".app/Contents/MacOS/")
}

func (paths Paths) daemonLauncher() string {
	if insideAppBundle(paths.DaemonBin) {
		return paths.DaemonBin
	}
	return stableDaemonPath(paths)
}

func (paths Paths) dropStableDaemon() {
	if !insideAppBundle(paths.DaemonBin) {
		return
	}
	_ = os.Remove(stableDaemonPath(paths))
}

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
}

func installStableDaemon(source, target string) (bool, error) {
	incoming, err := os.ReadFile(source)
	if err != nil {
		return false, err
	}
	if current, err := os.ReadFile(target); err == nil && sha256.Sum256(current) == sha256.Sum256(incoming) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return false, err
	}
	temp := target + ".new"
	if err := os.WriteFile(temp, incoming, 0o755); err != nil {
		return false, err
	}
	if err := os.Rename(temp, target); err != nil {
		return false, err
	}
	return true, nil
}

func launchAgentPlist(paths Paths, environment []string) []byte {
	arguments := append([]string{paths.daemonLauncher()}, paths.DaemonCommand()...)
	var document strings.Builder
	document.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	document.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	document.WriteString("<plist version=\"1.0\">\n<dict>\n")
	document.WriteString("\t<key>Label</key>\n\t<string>" + launchAgentLabel + "</string>\n")
	document.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, argument := range arguments {
		document.WriteString("\t\t<string>" + plistEscape(argument) + "</string>\n")
	}
	document.WriteString("\t</array>\n")
	document.WriteString("\t<key>RunAtLoad</key>\n\t<true/>\n")
	if len(environment) > 0 {
		document.WriteString("\t<key>EnvironmentVariables</key>\n\t<dict>\n")
		for _, entry := range environment {
			name, value, ok := strings.Cut(entry, "=")
			if !ok || name == "" {
				continue
			}
			document.WriteString("\t\t<key>" + plistEscape(name) + "</key>\n")
			document.WriteString("\t\t<string>" + plistEscape(value) + "</string>\n")
		}
		document.WriteString("\t</dict>\n")
	}
	document.WriteString("</dict>\n</plist>\n")
	return []byte(document.String())
}

func plistEscape(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return replacer.Replace(value)
}

func desktopBinaryName() string {
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	return "agent-desktop-" + runtime.GOOS + "-" + arch
}

func nativeDesktopBinary(graphHome string) string {
	if strings.TrimSpace(graphHome) == "" {
		return ""
	}
	path := filepath.Join(graphHome, "capabilities", "agent-desktop", "node_modules", "agent-desktop", "bin", desktopBinaryName())
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Mode().Perm()&0o111 == 0 {
		return ""
	}
	return path
}

func launchAgentEnvironment(paths Paths) []string {
	environment := []string{}
	for _, name := range []string{"HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"} {
		if value, ok := os.LookupEnv(name); ok {
			environment = append(environment, name+"="+value)
		}
	}
	if len(environment) == 0 || !hasEnvironment(environment, "PATH") {
		environment = append(environment, "PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
	}
	if native := nativeDesktopBinary(paths.GraphHome); native != "" {
		environment = append(environment, "GRAPH_DESKTOP_BIN="+native)
	}
	secrets := secretValues(secretsPath(paths.StateDir))
	names := make([]string, 0, len(secrets))
	for name := range secrets {
		names = append(names, name)
	}
	sortStrings(names)
	for _, name := range names {
		environment = append(environment, name+"="+secrets[name])
	}
	return environment
}

func hasEnvironment(environment []string, name string) bool {
	for _, entry := range environment {
		if strings.HasPrefix(entry, name+"=") {
			return true
		}
	}
	return false
}

func sortStrings(values []string) {
	for outer := 1; outer < len(values); outer++ {
		for inner := outer; inner > 0 && values[inner] < values[inner-1]; inner-- {
			values[inner], values[inner-1] = values[inner-1], values[inner]
		}
	}
}

func supervisedFromPPID(output string) bool {
	parent, err := strconv.Atoi(strings.TrimSpace(output))
	if err != nil {
		return false
	}
	return parent == 1
}

func daemonSupervised(pid int) bool {
	if pid <= 0 {
		return false
	}
	output, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	return supervisedFromPPID(string(output))
}

func writeLaunchAgent(path string, paths Paths) (bool, error) {
	plist := launchAgentPlist(paths, launchAgentEnvironment(paths))
	if current, err := os.ReadFile(path); err == nil && bytes.Equal(current, plist) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	if err := os.WriteFile(path, plist, 0o600); err != nil {
		return false, err
	}
	return true, nil
}

func (paths Paths) agentFile() string {
	if strings.TrimSpace(paths.LaunchAgentFile) != "" {
		return paths.LaunchAgentFile
	}
	return launchAgentPath()
}

func installLaunchAgent(paths Paths) (bool, error) {
	return writeLaunchAgent(paths.agentFile(), paths)
}

func launchAgentDomain() string {
	return "gui/" + strconv.Itoa(os.Getuid())
}

func launchAgentService() string {
	return launchAgentDomain() + "/" + launchAgentLabel
}

func launchAgentPlan(paths Paths, reload bool) [][]string {
	if reload {
		return [][]string{
			{"bootout", launchAgentService()},
			{"bootstrap", launchAgentDomain(), paths.agentFile()},
			{"kickstart", "-k", launchAgentService()},
		}
	}
	return [][]string{{"kickstart", "-k", launchAgentService()}}
}

func runLaunchAgentPlan(plan [][]string) error {
	var failure error
	for _, args := range plan {
		if err := exec.Command("launchctl", args...).Run(); err != nil && len(args) > 0 && args[0] != "bootout" {
			failure = err
		}
	}
	return failure
}

func launchAgentBoot(paths Paths) error {
	return runLaunchAgentPlan(launchAgentPlan(paths, true))
}
