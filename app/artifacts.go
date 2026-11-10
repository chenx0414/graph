package main

import (
	"encoding/json"
	"strconv"
)

const (
	transcriptWindow     = 40
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

func (c *chatState) showArtifact(row artifactRow) {
	payload, err := daemonGet(c.address, c.token, "/api/tasks/"+row.taskID+"/artifacts/"+row.artifactID+"/"+strconv.Itoa(row.version)+"/content")
	if err != nil {
		c.status = "读不到产物：" + err.Error()
		c.frame()
		return
	}
	text := string(payload)
	if len(text) > artifactPreviewLimit {
		text = text[:artifactPreviewLimit] + "…"
	}
	c.previewTitle = artifactLabel(row)
	c.preview = text
	c.status = ""
	c.frame()
}
