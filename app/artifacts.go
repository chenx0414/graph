package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/egoist/mygo"
)

const (
	artifactListLimit    = 8
	artifactPreviewLimit = 4000
)

type artifactRow struct {
	artifactID string
	taskID     string
	namespace  string
	name       string
	title      string
	mediaType  string
	version    int
	size       int64
}

type artifactListPayload struct {
	Artifacts []struct {
		ArtifactID string `json:"artifactId"`
		TaskID     string `json:"taskId"`
		Namespace  string `json:"namespace"`
		Name       string `json:"name"`
		Title      string `json:"title"`
		MediaType  string `json:"mediaType"`
		Version    int    `json:"version"`
		Size       int64  `json:"size"`
	} `json:"artifacts"`
}

func parseArtifacts(payload []byte) ([]artifactRow, error) {
	var listed artifactListPayload
	if err := json.Unmarshal(payload, &listed); err != nil {
		return nil, err
	}
	rows := make([]artifactRow, 0, len(listed.Artifacts))
	for _, artifact := range listed.Artifacts {
		rows = append(rows, artifactRow{
			artifactID: artifact.ArtifactID,
			taskID:     artifact.TaskID,
			namespace:  artifact.Namespace,
			name:       artifact.Name,
			title:      artifact.Title,
			mediaType:  artifact.MediaType,
			version:    artifact.Version,
			size:       artifact.Size,
		})
	}
	return rows, nil
}

func formatSize(size int64) string {
	switch {
	case size >= 1024*1024:
		return strconv.FormatFloat(float64(size)/(1024*1024), 'f', 1, 64) + " MB"
	case size >= 1024:
		return strconv.FormatFloat(float64(size)/1024, 'f', 1, 64) + " KB"
	}
	return strconv.FormatInt(size, 10) + " B"
}

func artifactLabel(row artifactRow) string {
	label := row.namespace
	if row.name != "" {
		label += "/" + row.name
	}
	return label + " · v" + strconv.Itoa(row.version) + " · " + formatSize(row.size)
}

func artifactExtension(mediaType string) string {
	switch {
	case strings.Contains(mediaType, "json"):
		return ".json"
	case strings.Contains(mediaType, "markdown"):
		return ".md"
	case strings.Contains(mediaType, "image/png"):
		return ".png"
	case strings.Contains(mediaType, "image/"):
		return ".img"
	case strings.Contains(mediaType, "html"):
		return ".html"
	case strings.Contains(mediaType, "text/"):
		return ".txt"
	}
	return ".bin"
}

func artifactFileName(row artifactRow) string {
	name := row.namespace
	if row.name != "" {
		name += "-" + row.name
	}
	name += "-v" + strconv.Itoa(row.version)
	return strings.NewReplacer("/", "-", " ", "-").Replace(name) + artifactExtension(row.mediaType)
}

func (c *chatState) artifactContent(row artifactRow) ([]byte, error) {
	return c.api.get("/api/tasks/" + row.taskID + "/artifacts/" + row.artifactID + "/" + strconv.Itoa(row.version) + "/content")
}

func exportArtifact(path string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, content, 0o644)
}

func (c *chatState) exportArtifactTo(row artifactRow, path string) {
	content, err := c.artifactContent(row)
	if err != nil {
		c.status = "导出失败：" + err.Error()
		c.frame()
		return
	}
	if err := exportArtifact(path, content); err != nil {
		c.status = "导出失败：" + err.Error()
		c.frame()
		return
	}
	c.status = "已导出到 " + path
	c.frame()
}

func (c *chatState) exportArtifactNow(row artifactRow) {
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Title: "导出产物", DefaultPath: artifactFileName(row)})
	if err != nil || path == "" {
		return
	}
	c.exportArtifactTo(row, path)
}

func (c *chatState) showArtifact(row artifactRow) {
	payload, err := c.artifactContent(row)
	if err != nil {
		c.status = "读不到产物：" + err.Error()
		c.frame()
		return
	}
	onUI(c.window, func() { c.setArtifactPreview(row, payload) })
	c.frame()
}

func (c *chatState) setArtifactPreview(row artifactRow, payload []byte) {
	text := string(payload)
	if len(text) > artifactPreviewLimit {
		text = text[:artifactPreviewLimit] + "…"
	}
	c.previewTitle = artifactLabel(row)
	c.preview = text
	c.previewRow = row
	c.status = ""
}
