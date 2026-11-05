package graph

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"io"
	"os"
	"path/filepath"

	"sync"
)

// maxHostOutputBytes is how much of one stream is kept: a check that prints more than this is
// flooding, not evidencing.
const maxHostOutputBytes = 32 * 1024 * 1024

// hostOutputStream is one preserved stream.
type hostOutputStream struct {
	path  string
	file  *os.File
	bytes int64
	hash  hash.Hash
}

// hostCommandBuffer keeps the bounded inline view of one stream.
type hostCommandBuffer struct {
	mutex  sync.Mutex
	chunks [][]byte
	bytes  int
}

// keep adds one chunk to the inline view.
func (buffer *hostCommandBuffer) keep(chunk []byte, state *hostCommandState) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	if buffer.bytes >= maxHostOutputBytes {
		state.truncated = true
		return
	}
	room := len(chunk)
	if remaining := maxHostOutputBytes - buffer.bytes; room > remaining {
		room = remaining
	}
	buffer.chunks = append(buffer.chunks, chunk[:room])
	if room < len(chunk) {
		state.truncated = true
	}
	buffer.bytes += room
}

// String returns the inline view of the stream.
func (buffer *hostCommandBuffer) String() string {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return string(bytes.Join(buffer.chunks, nil))
}

// hostCommandNumber reports whether a value is a number.
func hostCommandNumber(value any) bool {
	switch value.(type) {
	case float64, int, int64:
		return true
	}
	return false
}

// hostCommandTimeoutMarker is the line a command killed by its own budget leaves behind.
//
// The host writes it and the operation reads it, so both sides name the kill the
// same way: a missing exit code alone cannot tell "killed for time" from "the
// supervisor never answered", and the verdict has to tell them apart.
func hostCommandTimeoutMarker(timeoutMs int) string {
	return "Process terminated by SIGKILL: it exceeded the " + itoa(timeoutMs) + "ms timeout"
}

// hostCommandOutputStreams describes the stream files a command left in its own directory.
//
// A sandboxed command's streams are written by the spawner rather than by the
// supervisor, so the operation has to be able to name and digest them afterwards.
func hostCommandOutputStreams(directory string) map[string]HostCommandOutputFile {
	files := map[string]HostCommandOutputFile{}
	for _, name := range []string{"stdout", "stderr"} {
		path := filepath.Join(directory, name+".log")
		content, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(content)
		files[name] = HostCommandOutputFile{Path: path, Bytes: int64(len(content)), Digest: hex.EncodeToString(sum[:])}
	}
	return files
}

// preservedStream copies every byte of one stream into its file while the pump reads it.
//
// The bytes are copied, not the decoded text: a stream may carry bytes that are
// not valid UTF-8, and a preserved stream is evidence rather than a message.
type preservedStream struct {
	reader io.Reader
	file   *os.File
}

func (stream preservedStream) Read(chunk []byte) (int, error) {
	read, err := stream.reader.Read(chunk)
	if read > 0 && stream.file != nil {
		if _, writeErr := stream.file.Write(chunk[:read]); writeErr != nil {
			stream.file = nil
		}
	}
	return read, err
}

// send writes one message to the supervisor.
func (state *hostCommandState) send(message map[string]any) {
	if state.channel == nil {
		return
	}
	encoded, err := marshalJSON(message)
	if err != nil {
		return
	}
	_, _ = state.channel.Write(append([]byte(encoded), '\n'))
}

// readStream keeps one stream of the supervisor and preserves it.
func (state *hostCommandState) readStream(reader io.Reader, name string) {
	buffer := make([]byte, 64*1024)
	for {
		read, err := reader.Read(buffer)
		if read > 0 {
			chunk := buffer[:read]
			state.preserve(name, chunk)
			if name == "stdout" {
				state.stdout.keep(chunk, state)
			} else {
				state.stderr.keep(chunk, state)
			}
		}
		if err != nil {
			return
		}
	}
}

// preserve writes one chunk to the preserved file of a stream.
func (state *hostCommandState) preserve(name string, chunk []byte) {
	stream, ok := state.streams[name]
	if !ok {
		return
	}
	offset := 0
	for offset < len(chunk) {
		written, err := stream.file.Write(chunk[offset:])
		if err != nil {
			state.killTree()
			return
		}
		offset += written
	}
	stream.hash.Write(chunk)
	stream.bytes += int64(len(chunk))
}
