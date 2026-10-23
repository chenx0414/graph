package graph

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var sqliteName = regexp.MustCompile(`\.sqlite(-wal|-shm)?$`)
var secretName = regexp.MustCompile(`\.(pem|key|p12|pfx)$`)

// GitIdentity is the author and committer recorded on host commits.
type GitIdentity struct {
	Name  string
	Email string
}

type gitRun struct {
	Code   int
	Stdout string
	Stderr string
}

var gitFlags = []string{
	"-c", "core.pager=cat",
	"-c", "core.editor=true",
	"-c", "sequence.editor=true",
	"-c", "commit.gpgsign=false",
	"-c", "tag.gpgsign=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "advice.detachedHead=false",
}

func gitReal(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		abs, absErr := filepath.Abs(path)
		if absErr != nil {
			return path
		}
		return abs
	}
	return resolved
}

func runGit(cwd string, args []string, input *string, identity *GitIdentity, extraEnv map[string]string) gitRun {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append(append([]string{}, gitFlags...), args...)...)
	cmd.Dir = cwd
	env := os.Environ()
	name, email := "Graph", "graph@local"
	if identity != nil {
		if identity.Name != "" {
			name = identity.Name
		}
		if identity.Email != "" {
			email = identity.Email
		}
	}
	overlay := map[string]string{
		"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email,
		"GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": email,
		"GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat", "PAGER": "cat",
		"GIT_EDITOR": "true", "EDITOR": "true",
		"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
	}
	for key, value := range extraEnv {
		overlay[key] = value
	}
	for key, value := range overlay {
		env = append(env, key+"="+value)
	}
	cmd.Env = env
	if input != nil {
		cmd.Stdin = strings.NewReader(*input)
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if _, ok := err.(*exec.ExitError); !ok {
			return gitRun{Code: 1, Stdout: "", Stderr: err.Error()}
		}
	}
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	if code < 0 {
		code = 1
	}
	return gitRun{Code: code, Stdout: stdout.String(), Stderr: strings.TrimSpace(stderr.String())}
}

// Git runs git and trims stdout.
func Git(cwd string, args []string, input *string, identity *GitIdentity) gitRun {
	result := runGit(cwd, args, input, identity, nil)
	result.Stdout = strings.TrimSpace(result.Stdout)
	return result
}

// GitRaw keeps stdout bytes, including a leading status space and a trailing newline.
func GitRaw(cwd string, args []string, input *string, extraEnv map[string]string) gitRun {
	return runGit(cwd, args, input, nil, extraEnv)
}

// HasHead reports whether HEAD resolves.
func HasHead(cwd string) bool {
	return Git(cwd, []string{"rev-parse", "--verify", "-q", "HEAD"}, nil, nil).Code == 0
}

// HeadSha is HEAD, or nil when the repository has no commit.
func HeadSha(cwd string) *string { return RevParse(cwd, "HEAD") }

var HOST_EXCLUDES = []string{
	"# Graph host-managed excludes (local only)",
	".env", ".env.*", "secrets.json", ".DS_Store",
	"node_modules", "state/", "dist/", "coverage/",
	".stage/", "graph.config.json",
	"!.env.example", "!.env.sample", "!.env.template", "!.env.dist", "!.env.defaults",
}

type gitPathPair struct {
	GitDir    *string
	CommonDir *string
}
