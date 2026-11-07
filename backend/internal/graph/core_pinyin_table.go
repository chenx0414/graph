package graph

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

func PinyinFor(char string) *string {
	if v, ok := pinyinTable[char]; ok {
		out := v
		return &out
	}
	return nil
}

const PINYIN_TABLE_SIZE = 2256
