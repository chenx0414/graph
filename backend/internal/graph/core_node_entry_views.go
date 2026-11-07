package graph

type NodeEntry struct {
	Seq              int64   `json:"seq"`
	ID               string  `json:"id"`
	Role             string  `json:"role"`
	Kind             string  `json:"kind"`
	Text             string  `json:"text"`
	Data             Json    `json:"data"`
	OperationID      *string `json:"operationId"`
	CreatedAt        int64   `json:"createdAt"`
	ContentTruncated bool    `json:"contentTruncated"`
	ContentBytes     int64   `json:"contentBytes"`
}

type NodeEntryPage struct {
	Entries    []NodeEntry `json:"entries"`
	EntryCount int         `json:"entryCount"`
	Limit      int         `json:"limit"`
	HasOlder   bool        `json:"hasOlder"`
	HasNewer   bool        `json:"hasNewer"`
}

func nodeEntryColumns(full bool) string {
	flag := "0"
	if full {
		flag = "1"
	}
	return `seq,id,role,kind,operation_id,created_at,
    length(CAST(text AS BLOB)) AS text_bytes,COALESCE(length(CAST(data AS BLOB)),0) AS data_bytes,
    CASE WHEN ` + flag + ` OR length(CAST(text AS BLOB))<=4096 THEN text ELSE substr(text,1,512) END AS text,
    CASE WHEN ` + flag + ` OR length(CAST(data AS BLOB))<=4096 OR data IS NULL THEN data ELSE
      json_object('toolName',substr(json_extract(data,'$.toolName'),1,128),
        'toolCallId',substr(json_extract(data,'$.toolCallId'),1,256),
        'from',substr(json_extract(data,'$.from'),1,128),
        'peer',json(CASE WHEN json_extract(data,'$.peer')=1 THEN 'true' ELSE 'false' END),
        'isError',json(CASE WHEN json_extract(data,'$.isError')=1 OR json_extract(data,'$.error')=1 THEN 'true' ELSE 'false' END),
        'ordinal',json_extract(data,'$.ordinal')) END AS data`
}

func nodeEntryLimit(query NodeEntryQuery) int {
	if query.Limit != nil && isSafeInteger(*query.Limit) && *query.Limit > 0 {
		limit := int(*query.Limit)
		if limit > 500 {
			return 500
		}
		return limit
	}
	return 100
}

func nodeEntryMap(rows []map[string]any, full bool) []NodeEntry {
	entries := make([]NodeEntry, 0, len(rows))
	for _, row := range rows {
		var data Json
		if text := kernelString(row["data"]); text != "" {
			data = parseJSON(text)
		}
		var operationID *string
		if row["operation_id"] != nil {
			value := kernelString(row["operation_id"])
			operationID = &value
		}
		textBytes := kernelInt(row["text_bytes"])
		dataBytes := kernelInt(row["data_bytes"])
		entries = append(entries, NodeEntry{
			Seq: kernelInt(row["seq"]), ID: kernelString(row["id"]), Role: kernelString(row["role"]),
			Kind: kernelString(row["kind"]), Text: kernelString(row["text"]), Data: data,
			OperationID: operationID, CreatedAt: kernelInt(row["created_at"]),
			ContentTruncated: !full && (textBytes > 4096 || dataBytes > 4096),
			ContentBytes:     textBytes + dataBytes,
		})
	}
	return entries
}

func ListNodeEntries(store *TaskStore, taskId, nodeId string, query NodeEntryQuery) NodeEntryPage {
	limit := nodeEntryLimit(query)
	countRow := kernelRow(store.Db, "SELECT COUNT(*) AS count FROM node_entries WHERE task_id=? AND node_id=?", taskId, nodeId)
	entryCount := int(kernelInt(countRow["count"]))
	full := query.EntryID != nil
	columns := nodeEntryColumns(full)
	if full {
		rows := kernelRows(store.Db, `SELECT `+columns+` FROM node_entries WHERE task_id=? AND node_id=? AND id=?`,
			taskId, nodeId, *query.EntryID)
		if len(rows) == 0 {
			Raise("not_found", "Entry does not belong to this node")
		}
		return NodeEntryPage{Entries: nodeEntryMap(rows, full), EntryCount: entryCount, Limit: 1, HasOlder: false, HasNewer: false}
	}
	if query.Before != nil {
		rows := kernelRows(store.Db, `SELECT `+columns+` FROM node_entries
      WHERE task_id=? AND node_id=? AND seq<? ORDER BY seq DESC LIMIT ?`, taskId, nodeId, *query.Before, limit)
		reverseNodeEntries(rows)
		return NodeEntryPage{Entries: nodeEntryMap(rows, full), EntryCount: entryCount, Limit: limit, HasOlder: true, HasNewer: false}
	}
	if query.After != nil {
		after := int64(0)
		if isSafeInteger(*query.After) && *query.After >= 0 {
			after = int64(*query.After)
		}
		rows := kernelRows(store.Db, `SELECT `+columns+` FROM node_entries
      WHERE task_id=? AND node_id=? AND seq>? ORDER BY seq LIMIT ?`, taskId, nodeId, after, limit)
		hasNewer := false
		if len(rows) == limit && entryCount > 0 {
			maxRow := kernelRow(store.Db, "SELECT MAX(seq) AS seq FROM node_entries WHERE task_id=? AND node_id=?", taskId, nodeId)
			maxSeq := kernelInt(maxRow["seq"])
			hasNewer = kernelInt(rows[len(rows)-1]["seq"]) < maxSeq
		}
		return NodeEntryPage{Entries: nodeEntryMap(rows, full), EntryCount: entryCount, Limit: limit, HasOlder: true, HasNewer: hasNewer}
	}
	rows := kernelRows(store.Db, `SELECT `+columns+` FROM node_entries
    WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT ?`, taskId, nodeId, limit)
	oldest := int64(0)
	if len(rows) > 0 {
		oldest = kernelInt(rows[len(rows)-1]["seq"])
	}
	reverseNodeEntries(rows)
	firstRow := kernelRow(store.Db, "SELECT MIN(seq) AS seq FROM node_entries WHERE task_id=? AND node_id=?", taskId, nodeId)
	hasOlder := false
	if firstRow != nil && firstRow["seq"] != nil {
		hasOlder = oldest > kernelInt(firstRow["seq"])
	}
	return NodeEntryPage{Entries: nodeEntryMap(rows, full), EntryCount: entryCount, Limit: limit, HasOlder: hasOlder, HasNewer: false}
}

func reverseNodeEntries(rows []map[string]any) {
	for left, right := 0, len(rows)-1; left < right; left, right = left+1, right-1 {
		rows[left], rows[right] = rows[right], rows[left]
	}
}
