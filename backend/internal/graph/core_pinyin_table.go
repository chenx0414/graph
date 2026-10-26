package graph

// Pinyin table from src/core/pinyin-table.ts. First reading wins.
var pinyinTable = buildPinyinTable()

func buildPinyinTable() map[string]string {
	table := map[string]string{}
	for _, data := range []map[string]string{pinyinData01(), pinyinData02(), pinyinData03(), pinyinData04(), pinyinData05(), pinyinData06()} {
		for character, reading := range data {
			table[character] = reading
		}
	}
	return table
}

// PinyinFor returns the toneless reading, or nil when the character is not in the table.
func PinyinFor(char string) *string {
	if v, ok := pinyinTable[char]; ok {
		out := v
		return &out
	}
	return nil
}

// PINYIN_TABLE_SIZE is the number of characters in the built-in table.
const PINYIN_TABLE_SIZE = 2256
