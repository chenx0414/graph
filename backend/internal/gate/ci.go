package gate

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const ciWorkflowPath = ".github/workflows/ci.yml"
const nightlyWorkflowPath = ".github/workflows/nightly.yml"

type CIJob struct {
	Name  string
	Lines []string
}

type CILayer struct {
	Workflow string
	Jobs     []CIJob
}

var jobNamePattern = regexp.MustCompile(`^\s{2}([a-zA-Z][\w-]*):\s*$`)
var jobLabelPattern = regexp.MustCompile(`^\s{4}name:\s*(.+?)\s*$`)

// CILayers reads which jobs each workflow declares, so the documented layering
// can never claim a job that the workflow no longer has.
func CILayers(root string) ([]CILayer, error) {
	layers := []CILayer{}
	for _, relative := range []string{ciWorkflowPath, nightlyWorkflowPath} {
		path := filepath.Join(root, relative)
		payload, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		current := CIJob{}
		jobs := []CIJob{}
		inJobs := false
		for _, line := range strings.Split(string(payload), "\n") {
			if strings.HasPrefix(line, "jobs:") {
				inJobs = true
				continue
			}
			if !inJobs {
				continue
			}
			if match := jobNamePattern.FindStringSubmatch(line); match != nil {
				if current.Name != "" {
					jobs = append(jobs, current)
				}
				current = CIJob{Name: match[1]}
				continue
			}
			if current.Name == "" {
				continue
			}
			if match := jobLabelPattern.FindStringSubmatch(line); match != nil {
				current.Lines = append(current.Lines, strings.Trim(match[1], `"'`))
			}
		}
		if current.Name != "" {
			jobs = append(jobs, current)
		}
		sort.Slice(jobs, func(left, right int) bool { return jobs[left].Name < jobs[right].Name })
		layers = append(layers, CILayer{Workflow: relative, Jobs: jobs})
	}
	return layers, nil
}

func CIJobNames(layers []CILayer) []string {
	names := []string{}
	for _, layer := range layers {
		for _, job := range layer.Jobs {
			names = append(names, job.Name)
		}
	}
	sort.Strings(names)
	return names
}
