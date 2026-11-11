package harness

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var addressPattern = regexp.MustCompile(`address:\s+(http://127\.0\.0\.1:\d+)`)

type Daemon struct {
	URL    string
	cmd    *exec.Cmd
	stdout *strings.Builder
	stderr *strings.Builder
}

type DaemonOptions struct {
	Repository string
	Root       string
	ConfigPath string
	Mode       string
	Env        map[string]string
}

func daemonBinary(repository string) (string, error) {
	binary := filepath.Join(repository, "dist", "graphd")
	if _, err := os.Stat(binary); err == nil {
		return binary, nil
	}
	build := exec.Command("go", "-C", filepath.Join(repository, "backend"), "run", "./cmd/graphbuild", "backend")
	build.Stdout = os.Stderr
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return "", fmt.Errorf("the daemon binary is missing and could not be built: %w", err)
	}
	if _, err := os.Stat(binary); err != nil {
		return "", fmt.Errorf("the daemon binary is still missing after building: %w", err)
	}
	return binary, nil
}

func StartDaemon(options DaemonOptions) (*Daemon, error) {
	binary, err := daemonBinary(options.Repository)
	if err != nil {
		return nil, err
	}
	arguments := []string{
		"--application-root", options.Repository,
		"--state-dir", filepath.Join(options.Root, "state"),
		"--graph-home", filepath.Join(options.Root, "graph"),
		"--port", "0",
	}
	if options.Mode == "execute" {
		arguments = append(arguments, "--execute")
	} else {
		arguments = append(arguments, "--view-only")
	}
	if options.ConfigPath != "" {
		arguments = append(arguments, "--config", options.ConfigPath)
	}
	command := exec.Command(binary, arguments...)
	command.Dir = options.Root
	environment := os.Environ()
	for key, value := range options.Env {
		environment = append(environment, key+"="+value)
	}
	command.Env = environment
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	daemon := &Daemon{cmd: command, stdout: &strings.Builder{}, stderr: &strings.Builder{}}
	addresses := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			daemon.stdout.WriteString(line + "\n")
			if match := addressPattern.FindStringSubmatch(line); match != nil {
				select {
				case addresses <- match[1]:
				default:
				}
			}
		}
	}()
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			daemon.stderr.WriteString(scanner.Text() + "\n")
		}
	}()
	exited := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(exited)
	}()
	select {
	case url := <-addresses:
		daemon.URL = url
		return daemon, nil
	case <-exited:
		return nil, fmt.Errorf("the daemon exited before startup\n%s\n%s", daemon.stdout.String(), daemon.stderr.String())
	case <-time.After(30 * time.Second):
		_ = command.Process.Kill()
		return nil, fmt.Errorf("the daemon did not report an address\n%s\n%s", daemon.stdout.String(), daemon.stderr.String())
	}
}

func (d *Daemon) Close() {
	if d == nil || d.cmd == nil || d.cmd.Process == nil {
		return
	}
	_ = d.cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() {
		_ = d.cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(7 * time.Second):
		_ = d.cmd.Process.Kill()
		<-done
	}
}

func (d *Daemon) Output() string {
	if d == nil {
		return ""
	}
	return d.stdout.String() + d.stderr.String()
}

var errNoAddress = errors.New("the daemon reported no address")
