package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// Linux input event (64-bit)
type InputEvent struct {
	Time  syscall.Timeval
	Type  uint16
	Code  uint16
	Value int32
}

const (
	inputEventSize = 24

	EV_SYN = 0x00
	EV_KEY = 0x01

	SYN_REPORT = 0x00

	keyRelease = 0
	keyPress   = 1
	keyRepeat  = 2

	// Keycodes
	KEY_1           = 2
	KEY_2           = 3
	KEY_3           = 4
	KEY_4           = 5
	KEY_5           = 6
	KEY_6           = 7
	KEY_7           = 8
	KEY_8           = 9
	KEY_9           = 10
	KEY_0           = 11
	KEY_MINUS       = 12
	KEY_EQUAL       = 13
	KEY_BACKSPACE   = 14
	KEY_TAB         = 15
	KEY_Q           = 16
	KEY_W           = 17
	KEY_E           = 18
	KEY_R           = 19
	KEY_T           = 20
	KEY_Y           = 21
	KEY_U           = 22
	KEY_I           = 23
	KEY_O           = 24
	KEY_P           = 25
	KEY_LEFTBRACE   = 26
	KEY_RIGHTBRACE  = 27
	KEY_ENTER       = 28
	KEY_LEFTCTRL    = 29
	KEY_A           = 30
	KEY_S           = 31
	KEY_D           = 32
	KEY_F           = 33
	KEY_G           = 34
	KEY_H           = 35
	KEY_J           = 36
	KEY_K           = 37
	KEY_L           = 38
	KEY_SEMICOLON   = 39
	KEY_APOSTROPHE  = 40
	KEY_GRAVE       = 41
	KEY_LEFTSHIFT   = 42
	KEY_BACKSLASH   = 43
	KEY_Z           = 44
	KEY_X           = 45
	KEY_C           = 46
	KEY_V           = 47
	KEY_B           = 48
	KEY_N           = 49
	KEY_M           = 50
	KEY_COMMA       = 51
	KEY_DOT         = 52
	KEY_SLASH       = 53
	KEY_RIGHTSHIFT  = 54
	KEY_LEFTALT     = 56
	KEY_SPACE       = 57
	KEY_CAPSLOCK    = 58

	// uinput
	UI_SET_EVBIT   = 0x40045564
	UI_SET_KEYBIT  = 0x40045565
	UI_DEV_CREATE  = 0x5501
	UI_DEV_DESTROY = 0x5502
	UI_DEV_SETUP   = 0x405c5503

	EVIOCGRAB = 0x40044590

	BUS_USB = 0x03
)

const (
	maxKeyCode             = KEY_CAPSLOCK
	invalidIndex8          = int8(-1)
	debugLogging           = false
	minPreviewInterval     = 35 * time.Millisecond
	maxPreviewInterval     = 120 * time.Millisecond
	minIdleFlushDelay      = 100 * time.Millisecond
	maxIdleFlushDelay      = 260 * time.Millisecond
	adaptiveMinKeyGap      = 40 * time.Millisecond
	adaptiveMaxKeyGap      = 400 * time.Millisecond
	preloadedDeviceCount   = 1
)

// uinput 구조체
type UinputSetup struct {
	ID           InputID
	Name         [80]byte
	FFEffectsMax uint32
}

type InputID struct {
	Bustype uint16
	Vendor  uint16
	Product uint16
	Version uint16
}

type keyIndexPair struct {
	code  uint16
	value int8
}

type jongSplit struct {
	first  int8
	second int8
	ok     bool
}

type mappedKey struct {
	code    uint16
	shifted bool
}

type mappedKeyboard struct {
	fd        *os.File
	charToKey map[rune]mappedKey
}

type keyPatchSpec struct {
	code    uint16
	unicode uint16
	qtcode  uint32
	mod     byte
}

type keyPatchInfo struct {
	fileOffsets []int64
	origUnicode uint16
	origQtcode  uint32
}

func makeKeyIndexTable(pairs ...keyIndexPair) [maxKeyCode + 1]int8 {
	var table [maxKeyCode + 1]int8
	for i := range table {
		table[i] = invalidIndex8
	}
	for _, pair := range pairs {
		table[pair.code] = pair.value
	}
	return table
}

func debugf(format string, args ...any) {
	if debugLogging {
		log.Printf(format, args...)
	}
}

// 키맵 디스크 패칭: libepaper.so의 KEY_Q 엔트리를 직접 수정
// xochitl은 새 evdev 디바이스 감지 시 핸들러를 생성하며,
// 이때 디스크의 키맵 데이터를 읽어 내부 조회 테이블을 구축함
// → 디바이스를 재생성하면 패치된 키맵이 적용됨
type KeymapPatcher struct {
	fileOffsets []int64 // KEY_Q 엔트리의 파일 오프셋 목록
	diskPath    string  // libepaper.so 디스크 경로
	origUnicode uint16
	origQtcode  uint32
	keyEntries  map[uint32]keyPatchInfo
}

func keyEntryKey(code uint16, mod byte) uint32 {
	return uint32(code)<<8 | uint32(mod)
}

func keyCodeName(code uint16) string {
	switch code {
	case KEY_1:
		return "KEY_1"
	case KEY_2:
		return "KEY_2"
	case KEY_3:
		return "KEY_3"
	case KEY_4:
		return "KEY_4"
	case KEY_5:
		return "KEY_5"
	case KEY_6:
		return "KEY_6"
	case KEY_7:
		return "KEY_7"
	case KEY_8:
		return "KEY_8"
	case KEY_9:
		return "KEY_9"
	case KEY_0:
		return "KEY_0"
	case KEY_MINUS:
		return "KEY_MINUS"
	case KEY_EQUAL:
		return "KEY_EQUAL"
	case KEY_Q:
		return "KEY_Q"
	case KEY_W:
		return "KEY_W"
	case KEY_E:
		return "KEY_E"
	case KEY_R:
		return "KEY_R"
	case KEY_T:
		return "KEY_T"
	case KEY_Y:
		return "KEY_Y"
	case KEY_U:
		return "KEY_U"
	case KEY_I:
		return "KEY_I"
	case KEY_O:
		return "KEY_O"
	case KEY_P:
		return "KEY_P"
	case KEY_LEFTBRACE:
		return "KEY_LEFTBRACE"
	case KEY_RIGHTBRACE:
		return "KEY_RIGHTBRACE"
	case KEY_A:
		return "KEY_A"
	case KEY_S:
		return "KEY_S"
	case KEY_D:
		return "KEY_D"
	case KEY_F:
		return "KEY_F"
	case KEY_G:
		return "KEY_G"
	case KEY_H:
		return "KEY_H"
	case KEY_J:
		return "KEY_J"
	case KEY_K:
		return "KEY_K"
	case KEY_L:
		return "KEY_L"
	case KEY_SEMICOLON:
		return "KEY_SEMICOLON"
	case KEY_APOSTROPHE:
		return "KEY_APOSTROPHE"
	case KEY_GRAVE:
		return "KEY_GRAVE"
	case KEY_BACKSLASH:
		return "KEY_BACKSLASH"
	case KEY_Z:
		return "KEY_Z"
	case KEY_X:
		return "KEY_X"
	case KEY_C:
		return "KEY_C"
	case KEY_V:
		return "KEY_V"
	case KEY_B:
		return "KEY_B"
	case KEY_N:
		return "KEY_N"
	case KEY_M:
		return "KEY_M"
	case KEY_COMMA:
		return "KEY_COMMA"
	case KEY_DOT:
		return "KEY_DOT"
	case KEY_SLASH:
		return "KEY_SLASH"
	default:
		return fmt.Sprintf("KEY_%d", code)
	}
}

func allPlainKeyPatchSpecs() []keyPatchSpec {
	return []keyPatchSpec{
		{KEY_Q, 'q', 'Q', 0}, {KEY_W, 'w', 'W', 0}, {KEY_E, 'e', 'E', 0},
		{KEY_R, 'r', 'R', 0}, {KEY_T, 't', 'T', 0}, {KEY_Y, 'y', 'Y', 0},
		{KEY_U, 'u', 'U', 0}, {KEY_I, 'i', 'I', 0}, {KEY_O, 'o', 'O', 0},
		{KEY_P, 'p', 'P', 0}, {KEY_A, 'a', 'A', 0}, {KEY_S, 's', 'S', 0},
		{KEY_D, 'd', 'D', 0}, {KEY_F, 'f', 'F', 0}, {KEY_G, 'g', 'G', 0},
		{KEY_H, 'h', 'H', 0}, {KEY_J, 'j', 'J', 0}, {KEY_K, 'k', 'K', 0},
		{KEY_L, 'l', 'L', 0}, {KEY_Z, 'z', 'Z', 0}, {KEY_X, 'x', 'X', 0},
		{KEY_C, 'c', 'C', 0}, {KEY_V, 'v', 'V', 0}, {KEY_B, 'b', 'B', 0},
		{KEY_N, 'n', 'N', 0}, {KEY_M, 'm', 'M', 0},
		{KEY_1, '1', '1', 0}, {KEY_2, '2', '2', 0}, {KEY_3, '3', '3', 0},
		{KEY_4, '4', '4', 0}, {KEY_5, '5', '5', 0}, {KEY_6, '6', '6', 0},
		{KEY_7, '7', '7', 0}, {KEY_8, '8', '8', 0}, {KEY_9, '9', '9', 0},
		{KEY_0, '0', '0', 0}, {KEY_MINUS, '-', '-', 0}, {KEY_EQUAL, '=', '=', 0},
		{KEY_LEFTBRACE, '[', '[', 0}, {KEY_RIGHTBRACE, ']', ']', 0},
		{KEY_SEMICOLON, ';', ';', 0}, {KEY_APOSTROPHE, '\'', '\'', 0},
		{KEY_BACKSLASH, '\\', '\\', 0}, {KEY_COMMA, ',', ',', 0},
		{KEY_DOT, '.', '.', 0}, {KEY_SLASH, '/', '/', 0},
	}
}

func allShiftKeyPatchSpecs() []keyPatchSpec {
	return []keyPatchSpec{
		{KEY_Q, 'Q', 'Q', 1}, {KEY_W, 'W', 'W', 1}, {KEY_E, 'E', 'E', 1},
		{KEY_R, 'R', 'R', 1}, {KEY_T, 'T', 'T', 1}, {KEY_Y, 'Y', 'Y', 1},
		{KEY_U, 'U', 'U', 1}, {KEY_I, 'I', 'I', 1}, {KEY_O, 'O', 'O', 1},
		{KEY_P, 'P', 'P', 1}, {KEY_A, 'A', 'A', 1}, {KEY_S, 'S', 'S', 1},
		{KEY_D, 'D', 'D', 1}, {KEY_F, 'F', 'F', 1}, {KEY_G, 'G', 'G', 1},
		{KEY_H, 'H', 'H', 1}, {KEY_J, 'J', 'J', 1}, {KEY_K, 'K', 'K', 1},
		{KEY_L, 'L', 'L', 1}, {KEY_Z, 'Z', 'Z', 1}, {KEY_X, 'X', 'X', 1},
		{KEY_C, 'C', 'C', 1}, {KEY_V, 'V', 'V', 1}, {KEY_B, 'B', 'B', 1},
		{KEY_N, 'N', 'N', 1}, {KEY_M, 'M', 'M', 1},
		{KEY_1, '!', '!', 1}, {KEY_2, '@', '@', 1}, {KEY_3, '#', '#', 1},
		{KEY_4, '$', '$', 1}, {KEY_5, '%', '%', 1}, {KEY_7, '&', '&', 1},
		{KEY_8, '*', '*', 1}, {KEY_9, '(', '(', 1}, {KEY_0, ')', ')', 1},
		{KEY_MINUS, '_', '_', 1}, {KEY_EQUAL, '+', '+', 1},
		{KEY_LEFTBRACE, '{', '{', 1}, {KEY_RIGHTBRACE, '}', '}', 1},
		{KEY_SEMICOLON, ':', ':', 1}, {KEY_APOSTROPHE, '"', '"', 1},
		{KEY_BACKSLASH, '|', '|', 1}, {KEY_COMMA, '<', '<', 1},
		{KEY_DOT, '>', '>', 1}, {KEY_SLASH, '?', '?', 1},
	}
}

func allPreloadKeyPatchSpecs() []keyPatchSpec {
	specs := append([]keyPatchSpec{}, allPlainKeyPatchSpecs()...)
	specs = append(specs, allShiftKeyPatchSpecs()...)
	return specs
}

func mappedKeyFromSpec(spec keyPatchSpec) mappedKey {
	return mappedKey{code: spec.code, shifted: spec.mod != 0}
}

func signatureForKeyEntry(spec keyPatchSpec) []byte {
	sig := make([]byte, 9)
	binary.LittleEndian.PutUint16(sig[0:2], spec.code)
	binary.LittleEndian.PutUint16(sig[2:4], spec.unicode)
	binary.LittleEndian.PutUint32(sig[4:8], spec.qtcode)
	sig[8] = spec.mod
	return sig
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func (kp *KeymapPatcher) init() error {
	kp.diskPath = "/usr/lib/plugins/platforms/libepaper.so"
	kp.keyEntries = make(map[uint32]keyPatchInfo)
	backupPath := "/tmp/libepaper.so.original"

	// KEY_Q plain 엔트리 시그니처: keycode=0x10, unicode='q', qtcode=Qt::Key_Q, mod=0
	signature := []byte{0x10, 0x00, 0x71, 0x00, 0x51, 0x00, 0x00, 0x00, 0x00}

	kp.fileOffsets = searchFileForSignature(kp.diskPath, signature)

	if len(kp.fileOffsets) == 0 {
		// 이전 세션에서 패치된 상태일 수 있음 → 백업에서 복원
		if _, err := os.Stat(backupPath); err == nil {
			log.Println("[PATCHER] 이전 패치 감지, 백업에서 복원 중...")
			if err := copyFile(backupPath, kp.diskPath); err != nil {
				return fmt.Errorf("backup restore failed: %w", err)
			}
			kp.fileOffsets = searchFileForSignature(kp.diskPath, signature)
		}
	}

	if len(kp.fileOffsets) == 0 {
		return fmt.Errorf("KEY_Q entry not found in %s", kp.diskPath)
	}

	// 백업 생성 (없으면)
	if _, err := os.Stat(backupPath); err != nil {
		if err := copyFile(kp.diskPath, backupPath); err != nil {
			log.Printf("[PATCHER] 백업 생성 실패: %v", err)
		} else {
			log.Printf("[PATCHER] 백업 생성: %s", backupPath)
		}
	}

	// 원본 값 (항상 동일)
	kp.origUnicode = 0x0071     // 'q'
	kp.origQtcode = 0x00000051 // Qt::Key_Q

	log.Printf("[PATCHER] %s 에서 %d개의 KEY_Q 엔트리 발견", kp.diskPath, len(kp.fileOffsets))
	for i, fOff := range kp.fileOffsets {
		log.Printf("  [%d] fileOffset=0x%x", i, fOff)
	}

	// 쓰기 가능 여부 테스트
	f, err := os.OpenFile(kp.diskPath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("cannot write to %s (mount -o remount,rw / 필요?): %w", kp.diskPath, err)
	}
	f.Close()

	return nil
}

func searchFileForSignature(path string, signature []byte) []int64 {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil
	}
	fileSize := fi.Size()

	var offsets []int64
	buf := make([]byte, 4096)
	sigLen := int64(len(signature))

	for off := int64(0); off < fileSize; off += int64(len(buf)) - sigLen {
		readSize := int64(len(buf))
		if off+readSize > fileSize {
			readSize = fileSize - off
		}
		n, err := f.ReadAt(buf[:readSize], off)
		if err != nil || int64(n) < sigLen {
			continue
		}
		for i := 0; i <= n-len(signature); i++ {
			match := true
			for j := 0; j < len(signature); j++ {
				if buf[i+j] != signature[j] {
					match = false
					break
				}
			}
			if match {
				offsets = append(offsets, off+int64(i))
			}
		}
	}
	return offsets
}

func (kp *KeymapPatcher) initKeyEntry(spec keyPatchSpec) error {
	signature := signatureForKeyEntry(spec)
	offsets := searchFileForSignature(kp.diskPath, signature)
	if len(offsets) == 0 {
		return fmt.Errorf("key entry not found: code=%d unicode=U+%04X qt=0x%08x mod=%d", spec.code, spec.unicode, spec.qtcode, spec.mod)
	}
	kp.keyEntries[keyEntryKey(spec.code, spec.mod)] = keyPatchInfo{
		fileOffsets: offsets,
		origUnicode: spec.unicode,
		origQtcode:  spec.qtcode,
	}
	return nil
}

func (kp *KeymapPatcher) initPreloadEntries() error {
	for _, spec := range allPreloadKeyPatchSpecs() {
		if err := kp.initKeyEntry(spec); err != nil {
			return err
		}
	}
	return nil
}

func (kp *KeymapPatcher) writeKeyToDisk(code uint16, unicode uint16, qtcode uint32) error {
	entry, ok := kp.keyEntries[keyEntryKey(code, 0)]
	if !ok {
		return fmt.Errorf("key entry missing: %s", keyCodeName(code))
	}
	f, err := os.OpenFile(kp.diskPath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open %s for write: %w", kp.diskPath, err)
	}
	defer f.Close()

	var uniBuf [2]byte
	binary.LittleEndian.PutUint16(uniBuf[:], unicode)
	var qtBuf [4]byte
	binary.LittleEndian.PutUint32(qtBuf[:], qtcode)

	for _, fOff := range entry.fileOffsets {
		if _, err := f.WriteAt(uniBuf[:], fOff+2); err != nil {
			return fmt.Errorf("write unicode at 0x%x: %w", fOff+2, err)
		}
		if _, err := f.WriteAt(qtBuf[:], fOff+4); err != nil {
			return fmt.Errorf("write qtcode at 0x%x: %w", fOff+4, err)
		}
	}
	return nil
}

func (kp *KeymapPatcher) writeKeyEntryToDisk(code uint16, mod byte, unicode uint16, qtcode uint32) error {
	entry, ok := kp.keyEntries[keyEntryKey(code, mod)]
	if !ok {
		return fmt.Errorf("key entry missing: %s mod=%d", keyCodeName(code), mod)
	}
	f, err := os.OpenFile(kp.diskPath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open %s for write: %w", kp.diskPath, err)
	}
	defer f.Close()

	var uniBuf [2]byte
	binary.LittleEndian.PutUint16(uniBuf[:], unicode)
	var qtBuf [4]byte
	binary.LittleEndian.PutUint32(qtBuf[:], qtcode)

	for _, fOff := range entry.fileOffsets {
		if _, err := f.WriteAt(uniBuf[:], fOff+2); err != nil {
			return fmt.Errorf("write unicode at 0x%x: %w", fOff+2, err)
		}
		if _, err := f.WriteAt(qtBuf[:], fOff+4); err != nil {
			return fmt.Errorf("write qtcode at 0x%x: %w", fOff+4, err)
		}
	}
	return nil
}

func (kp *KeymapPatcher) restoreKeyEntry(code uint16, mod byte) error {
	entry, ok := kp.keyEntries[keyEntryKey(code, mod)]
	if !ok {
		return fmt.Errorf("key entry missing: %s mod=%d", keyCodeName(code), mod)
	}
	return kp.writeKeyEntryToDisk(code, mod, entry.origUnicode, entry.origQtcode)
}

func (kp *KeymapPatcher) restoreKey(code uint16) error {
	return kp.restoreKeyEntry(code, 0)
}

func (kp *KeymapPatcher) writeToDisk(unicode uint16, qtcode uint32) error {
	f, err := os.OpenFile(kp.diskPath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open %s for write: %w", kp.diskPath, err)
	}
	defer f.Close()

	var uniBuf [2]byte
	binary.LittleEndian.PutUint16(uniBuf[:], unicode)
	var qtBuf [4]byte
	binary.LittleEndian.PutUint32(qtBuf[:], qtcode)

	for _, fOff := range kp.fileOffsets {
		if _, err := f.WriteAt(uniBuf[:], fOff+2); err != nil {
			return fmt.Errorf("write unicode at 0x%x: %w", fOff+2, err)
		}
		if _, err := f.WriteAt(qtBuf[:], fOff+4); err != nil {
			return fmt.Errorf("write qtcode at 0x%x: %w", fOff+4, err)
		}
	}
	return nil
}

func (kp *KeymapPatcher) restoreDisk() {
	if err := kp.writeToDisk(kp.origUnicode, kp.origQtcode); err != nil {
		log.Printf("[PATCHER] 디스크 복원 실패: %v", err)
	} else {
		log.Printf("[PATCHER] 디스크 원본 복원 완료")
	}
}

// 두벌식 자판 매핑
var choseongMap = makeKeyIndexTable(
	keyIndexPair{KEY_R, 0}, keyIndexPair{KEY_E, 3}, keyIndexPair{KEY_Q, 7},
	keyIndexPair{KEY_T, 9}, keyIndexPair{KEY_D, 11}, keyIndexPair{KEY_W, 12},
	keyIndexPair{KEY_Z, 15}, keyIndexPair{KEY_X, 16}, keyIndexPair{KEY_C, 14},
	keyIndexPair{KEY_V, 17}, keyIndexPair{KEY_G, 18}, keyIndexPair{KEY_A, 6},
	keyIndexPair{KEY_S, 2}, keyIndexPair{KEY_F, 5},
)

var choseongShiftMap = makeKeyIndexTable(
	keyIndexPair{KEY_R, 1}, keyIndexPair{KEY_E, 4}, keyIndexPair{KEY_Q, 8},
	keyIndexPair{KEY_T, 10}, keyIndexPair{KEY_W, 13},
)

var jungseongMap = makeKeyIndexTable(
	keyIndexPair{KEY_K, 0}, keyIndexPair{KEY_O, 1}, keyIndexPair{KEY_I, 2},
	keyIndexPair{KEY_J, 4}, keyIndexPair{KEY_P, 5}, keyIndexPair{KEY_U, 6},
	keyIndexPair{KEY_H, 8}, keyIndexPair{KEY_Y, 12}, keyIndexPair{KEY_N, 13},
	keyIndexPair{KEY_B, 17}, keyIndexPair{KEY_M, 18}, keyIndexPair{KEY_L, 20},
)

var jungseongShiftMap = makeKeyIndexTable(
	keyIndexPair{KEY_O, 3}, keyIndexPair{KEY_P, 7},
)

var jongseongMap = makeKeyIndexTable(
	keyIndexPair{KEY_R, 1}, keyIndexPair{KEY_S, 4}, keyIndexPair{KEY_E, 7},
	keyIndexPair{KEY_F, 8}, keyIndexPair{KEY_A, 16}, keyIndexPair{KEY_Q, 17},
	keyIndexPair{KEY_T, 19}, keyIndexPair{KEY_D, 21}, keyIndexPair{KEY_W, 22},
	keyIndexPair{KEY_C, 23}, keyIndexPair{KEY_Z, 24}, keyIndexPair{KEY_X, 25},
	keyIndexPair{KEY_V, 26}, keyIndexPair{KEY_G, 27},
)

var jongseongShiftMap = makeKeyIndexTable(
	keyIndexPair{KEY_T, 20},
)

var jongseongToChoseong = [28]int8{
	0: invalidIndex8, 1: 0, 2: invalidIndex8, 3: invalidIndex8, 4: 2, 5: invalidIndex8, 6: invalidIndex8, 7: 3,
	8: 5, 9: invalidIndex8, 10: invalidIndex8, 11: invalidIndex8, 12: invalidIndex8, 13: invalidIndex8, 14: invalidIndex8, 15: invalidIndex8,
	16: 6, 17: 7, 18: invalidIndex8, 19: 9, 20: 10, 21: 11, 22: 12, 23: 14,
	24: 15, 25: 16, 26: 17, 27: 18,
}

var choseongToJamo = []rune{
	0x3131, 0x3132, 0x3134, 0x3137, 0x3138, 0x3139, 0x3141, 0x3142,
	0x3143, 0x3145, 0x3146, 0x3147, 0x3148, 0x3149, 0x314A, 0x314B,
	0x314C, 0x314D, 0x314E,
}

var jungseongToJamo = []rune{
	0x314F, 0x3150, 0x3151, 0x3152, 0x3153, 0x3154, 0x3155, 0x3156,
	0x3157, 0x3158, 0x3159, 0x315A, 0x315B, 0x315C, 0x315D, 0x315E,
	0x315F, 0x3160, 0x3161, 0x3162, 0x3163,
}

func composeSyllable(cho, jung, jong int) rune {
	return rune(0xAC00 + (cho*21+jung)*28 + jong)
}

func getCompoundJungseong(first, second int) int {
	switch {
	case first == 8 && second == 0:
		return 9
	case first == 8 && second == 1:
		return 10
	case first == 8 && second == 20:
		return 11
	case first == 13 && second == 4:
		return 14
	case first == 13 && second == 5:
		return 15
	case first == 13 && second == 20:
		return 16
	case first == 18 && second == 20:
		return 19
	default:
		return -1
	}
}

func splitCompoundJungseong(jung int) jongSplit {
	switch jung {
	case 9:
		return jongSplit{8, 0, true}
	case 10:
		return jongSplit{8, 1, true}
	case 11:
		return jongSplit{8, 20, true}
	case 14:
		return jongSplit{13, 4, true}
	case 15:
		return jongSplit{13, 5, true}
	case 16:
		return jongSplit{13, 20, true}
	case 19:
		return jongSplit{18, 20, true}
	default:
		return jongSplit{}
	}
}

func getCompoundJongseong(first, second int) int {
	switch {
	case first == 1 && second == 19:
		return 3
	case first == 4 && second == 22:
		return 5
	case first == 4 && second == 27:
		return 6
	case first == 8 && second == 1:
		return 9
	case first == 8 && second == 16:
		return 10
	case first == 8 && second == 17:
		return 11
	case first == 8 && second == 19:
		return 12
	case first == 8 && second == 25:
		return 13
	case first == 8 && second == 26:
		return 14
	case first == 8 && second == 27:
		return 15
	case first == 17 && second == 19:
		return 18
	default:
		return -1
	}
}

func splitCompoundJongseong(jong int) jongSplit {
	switch jong {
	case 3:
		return jongSplit{1, 19, true}
	case 5:
		return jongSplit{4, 22, true}
	case 6:
		return jongSplit{4, 27, true}
	case 9:
		return jongSplit{8, 1, true}
	case 10:
		return jongSplit{8, 16, true}
	case 11:
		return jongSplit{8, 17, true}
	case 12:
		return jongSplit{8, 19, true}
	case 13:
		return jongSplit{8, 25, true}
	case 14:
		return jongSplit{8, 26, true}
	case 15:
		return jongSplit{8, 27, true}
	case 18:
		return jongSplit{17, 19, true}
	default:
		return jongSplit{}
	}
}

const (
	stateEmpty     = 0
	stateChoseong  = 1
	stateJungseong = 2
	stateJongseong = 3
)

type HangulState struct {
	state int
	cho   int
	jung  int
	jong  int
}

type Daemon struct {
	mu               sync.Mutex
	inputFd          *os.File
	uinputFd         *os.File
	preloadedKeyboards []mappedKeyboard
	korean           bool
	shifted        bool
	ctrl_or_alt    bool
	pendingVisible bool
	visibleChar    rune
	lastPreviewAt  time.Time
	lastTypingAt   time.Time
	lastKeyGap     time.Duration
	hangul         HangulState
	patcher        *KeymapPatcher
	lastChar       rune // 현재 디스크에 패치된 문자 (0=원본)
	idleFlushSeq   uint64
}

func ioctl(fd uintptr, request uintptr, arg uintptr) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, request, arg)
	if errno != 0 {
		return errno
	}
	return nil
}

func createUinputDevice(name string) (*os.File, error) {
	f, err := os.OpenFile("/dev/uinput", os.O_WRONLY, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/uinput: %w", err)
	}
	fd := f.Fd()

	if err := ioctl(fd, UI_SET_EVBIT, uintptr(EV_KEY)); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_SET_EVBIT: %w", err)
	}
	if err := ioctl(fd, UI_SET_EVBIT, uintptr(EV_SYN)); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_SET_EVBIT SYN: %w", err)
	}
	for i := uintptr(0); i < 256; i++ {
		if err := ioctl(fd, UI_SET_KEYBIT, i); err != nil {
			f.Close()
			return nil, fmt.Errorf("UI_SET_KEYBIT %d: %w", i, err)
		}
	}

	setup := UinputSetup{
		ID: InputID{Bustype: BUS_USB, Vendor: 0x1234, Product: 0x5678, Version: 1},
	}
	copy(setup.Name[:], name)

	if err := ioctl(fd, UI_DEV_SETUP, uintptr(unsafe.Pointer(&setup))); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_DEV_SETUP: %w", err)
	}
	if err := ioctl(fd, UI_DEV_CREATE, 0); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_DEV_CREATE: %w", err)
	}
	return f, nil
}

func (d *Daemon) setupUinput() error {
	f, err := createUinputDevice("Hangul Virtual Keyboard")
	if err != nil {
		return err
	}
	d.uinputFd = f
	log.Println("[UINPUT] 기본 디바이스 생성 완료")
	return nil
}

// recreateUinput: uinput 디바이스를 파괴하고 재생성
// xochitl이 새 핸들러를 생성하며, 이때 디스크의 (패치된) 키맵을 로드
func (d *Daemon) recreateUinput() error {
	if d.uinputFd != nil {
		_ = ioctl(d.uinputFd.Fd(), UI_DEV_DESTROY, 0)
		d.uinputFd.Close()
		d.uinputFd = nil
	}

	// xochitl 핸들러 정리 대기
	time.Sleep(30 * time.Millisecond)

	if err := d.setupUinput(); err != nil {
		return fmt.Errorf("recreate uinput: %w", err)
	}

	// xochitl이 새 디바이스를 감지하고 핸들러를 생성할 때까지 대기
	// journal 로그 기준 ~44ms 소요
	time.Sleep(80 * time.Millisecond)

	return nil
}

func writeEventTo(f *os.File, typ uint16, code uint16, value int32) error {
	var buf [inputEventSize]byte
	binary.LittleEndian.PutUint64(buf[0:8], 0)
	binary.LittleEndian.PutUint64(buf[8:16], 0)
	binary.LittleEndian.PutUint16(buf[16:18], typ)
	binary.LittleEndian.PutUint16(buf[18:20], code)
	binary.LittleEndian.PutUint32(buf[20:24], uint32(value))
	fd := int(f.Fd())
	_, err := syscall.Write(fd, buf[:])
	return err
}

func sendKeyTapOn(f *os.File, code uint16) {
	_ = writeEventTo(f, EV_KEY, code, keyPress)
	_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
	time.Sleep(2 * time.Millisecond)
	_ = writeEventTo(f, EV_KEY, code, keyRelease)
	_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
}

func sendMappedKeyTapOn(f *os.File, key mappedKey) {
	if !key.shifted {
		sendKeyTapOn(f, key.code)
		return
	}
	_ = writeEventTo(f, EV_KEY, KEY_LEFTSHIFT, keyPress)
	_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
	time.Sleep(1 * time.Millisecond)
	_ = writeEventTo(f, EV_KEY, key.code, keyPress)
	_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
	time.Sleep(2 * time.Millisecond)
	_ = writeEventTo(f, EV_KEY, key.code, keyRelease)
	_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
	time.Sleep(1 * time.Millisecond)
	_ = writeEventTo(f, EV_KEY, KEY_LEFTSHIFT, keyRelease)
	_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
}

func sendMappedKeySequenceOn(f *os.File, keys ...mappedKey) {
	for _, key := range keys {
		if key.shifted {
			_ = writeEventTo(f, EV_KEY, KEY_LEFTSHIFT, keyPress)
			_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
		}
		_ = writeEventTo(f, EV_KEY, key.code, keyPress)
		_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
		_ = writeEventTo(f, EV_KEY, key.code, keyRelease)
		_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
		if key.shifted {
			_ = writeEventTo(f, EV_KEY, KEY_LEFTSHIFT, keyRelease)
			_ = writeEventTo(f, EV_SYN, SYN_REPORT, 0)
		}
	}
}

func (d *Daemon) writeEvent(typ uint16, code uint16, value int32) error {
	return writeEventTo(d.uinputFd, typ, code, value)
}

func (d *Daemon) sendKey(code uint16, press bool) {
	val := int32(keyRelease)
	if press {
		val = keyPress
	}
	_ = d.writeEvent(EV_KEY, code, val)
	_ = d.writeEvent(EV_SYN, SYN_REPORT, 0)
}

func (d *Daemon) sendKeyTap(code uint16) {
	d.sendKey(code, true)
	d.sendKey(code, false)
}

func (d *Daemon) sendKeySequence(codes ...uint16) {
	for _, code := range codes {
		_ = d.writeEvent(EV_KEY, code, keyPress)
		_ = d.writeEvent(EV_KEY, code, keyRelease)
	}
	_ = d.writeEvent(EV_SYN, SYN_REPORT, 0)
}

func (d *Daemon) sendBackspace() {
	d.sendKeyTap(KEY_BACKSPACE)
	time.Sleep(1 * time.Millisecond)
}

func (d *Daemon) passthrough(ev InputEvent) {
	_ = d.writeEvent(ev.Type, ev.Code, ev.Value)
}

// outputChar: 한글 문자를 xochitl에 전달
// 1. 디스크 패치 (문자 변경 시)
// 2. uinput 디바이스 재생성 (xochitl이 패치된 키맵으로 새 핸들러 생성)
// 3. 백스페이스 전송 (필요 시)
// 4. KEY_Q 전송 → xochitl이 패치된 문자로 표시
func (d *Daemon) outputChar(char rune, backspaces int, batchReplace bool) {
	if fd, mapped, ok := d.lookupPreloadedChar(char); ok {
		if batchReplace && backspaces == 1 {
			d.sendKeySequence(KEY_BACKSPACE)
			sendMappedKeySequenceOn(fd, mapped)
			return
		}
		for i := 0; i < backspaces; i++ {
			d.sendKeyTap(KEY_BACKSPACE)
		}
		if backspaces > 0 {
			time.Sleep(2 * time.Millisecond)
		}
		sendMappedKeyTapOn(fd, mapped)
		return
	}

	if d.patcher == nil {
		log.Printf("[OUTPUT] 패처 미초기화")
		return
	}

	if char != d.lastChar {
		if err := d.patcher.writeToDisk(uint16(char), uint32(char)); err != nil {
			log.Printf("[OUTPUT] 디스크 쓰기 오류: %v", err)
			return
		}
		if err := d.recreateUinput(); err != nil {
			log.Printf("[OUTPUT] 디바이스 재생성 오류: %v", err)
			return
		}
		d.lastChar = char
		debugf("[OUTPUT] U+%04X (%c) 로드 완료 (디바이스 재생성)", char, char)
	}

	if batchReplace && backspaces == 1 {
		d.sendKeySequence(KEY_BACKSPACE, KEY_Q)
		return
	}

	for i := 0; i < backspaces; i++ {
		d.sendKeyTap(KEY_BACKSPACE)
	}
	if backspaces > 0 {
		time.Sleep(2 * time.Millisecond)
	}

	d.sendKeyTap(KEY_Q)
}

// restoreKeymap: 영문 모드 전환 시 원본 키맵 복원
func (d *Daemon) restoreKeymap() {
	if d.lastChar != 0 && d.patcher != nil {
		d.patcher.restoreDisk()
		if err := d.recreateUinput(); err != nil {
			log.Printf("[RESTORE] 디바이스 재생성 오류: %v", err)
		}
		d.lastChar = 0
		log.Printf("[RESTORE] 원본 키맵 복원 완료")
	}
}


func orderedUniqueRunes(input []rune) []rune {
	seen := make(map[rune]struct{}, len(input))
	out := make([]rune, 0, len(input))
	for _, r := range input {
		if r == 0 || r == ' ' || r == '\n' || r == '\t' {
			continue
		}
		if _, ok := seen[r]; ok {
			continue
		}
		seen[r] = struct{}{}
		out = append(out, r)
	}
	return out
}

func appendVisibleRune(out *[]rune, r rune) {
	if r != 0 {
		*out = append(*out, r)
	}
}

func buildStablePreloadChars() []rune {
	out := make([]rune, 0, 80)
	out = append(out, choseongToJamo...)
	out = append(out, jungseongToJamo...)
	out = append(out, []rune("안녕하세요.이상하네요감사합니다녀합정도면반갑습문제최적화잘되" )...)
	return orderedUniqueRunes(out)
}

func buildPreloadDeviceCharSets() ([][]rune, error) {
	sets := [][]rune{
		buildStablePreloadChars(),
	}
	if len(sets) != preloadedDeviceCount {
		return nil, fmt.Errorf("preload device count mismatch: got=%d want=%d", len(sets), preloadedDeviceCount)
	}
	seen := make(map[rune]int)
	for i, chars := range sets {
		chars = orderedUniqueRunes(chars)
		if len(chars) == 0 {
			return nil, fmt.Errorf("preload device %d has no chars", i)
		}
		for _, char := range chars {
			if prev, ok := seen[char]; ok {
				return nil, fmt.Errorf("duplicate preload char U+%04X (%c) across devices %d and %d", char, char, prev, i)
			}
			seen[char] = i
		}
		sets[i] = chars
	}
	return sets, nil
}

func (d *Daemon) setupPreloadedKeyboards() error {
	if err := d.patcher.initPreloadEntries(); err != nil {
		return fmt.Errorf("init preload entries: %w", err)
	}
	charSets, err := buildPreloadDeviceCharSets()
	if err != nil {
		return err
	}
	slots := allPreloadKeyPatchSpecs()
	keyboards := make([]mappedKeyboard, 0, len(charSets))
	totalChars := 0
	for idx, chars := range charSets {
		if len(chars) > len(slots) {
			return fmt.Errorf("preload device %d chars=%d exceeds available slots=%d", idx, len(chars), len(slots))
		}
		charToKey := make(map[rune]mappedKey, len(chars))
		usedSpecs := make([]keyPatchSpec, 0, len(chars))
		for i, char := range chars {
			spec := slots[i]
			if err := d.patcher.writeKeyEntryToDisk(spec.code, spec.mod, uint16(char), uint32(char)); err != nil {
				for _, used := range usedSpecs {
					_ = d.patcher.restoreKeyEntry(used.code, used.mod)
				}
				for _, kb := range keyboards {
					if kb.fd != nil {
						_ = ioctl(kb.fd.Fd(), UI_DEV_DESTROY, 0)
						_ = kb.fd.Close()
					}
				}
				return fmt.Errorf("preload device %d write %s shift=%t for U+%04X: %w", idx, keyCodeName(spec.code), spec.mod != 0, char, err)
			}
			mapped := mappedKeyFromSpec(spec)
			charToKey[char] = mapped
			usedSpecs = append(usedSpecs, spec)
		}

		f, err := createUinputDevice(fmt.Sprintf("Hangul Preloaded %d", idx))
		if err != nil {
			for _, used := range usedSpecs {
				_ = d.patcher.restoreKeyEntry(used.code, used.mod)
			}
			for _, kb := range keyboards {
				if kb.fd != nil {
					_ = ioctl(kb.fd.Fd(), UI_DEV_DESTROY, 0)
					_ = kb.fd.Close()
				}
			}
			return fmt.Errorf("create preload device %d: %w", idx, err)
		}
		time.Sleep(700 * time.Millisecond)
		for _, used := range usedSpecs {
			if err := d.patcher.restoreKeyEntry(used.code, used.mod); err != nil {
				log.Printf("[PRELOAD %d] restore %s shift=%t failed: %v", idx, keyCodeName(used.code), used.mod != 0, err)
			}
		}
		keyboards = append(keyboards, mappedKeyboard{fd: f, charToKey: charToKey})
		totalChars += len(chars)
		log.Printf("[PRELOAD %d] device ready chars=%d", idx, len(chars))
	}
	d.preloadedKeyboards = keyboards
	time.Sleep(700 * time.Millisecond)
	log.Printf("[PRELOAD] total devices=%d total chars=%d", len(keyboards), totalChars)
	return nil
}

func (d *Daemon) lookupPreloadedChar(char rune) (*os.File, mappedKey, bool) {
	for _, kb := range d.preloadedKeyboards {
		if kb.fd == nil {
			continue
		}
		if mapped, ok := kb.charToKey[char]; ok {
			return kb.fd, mapped, true
		}
	}
	return nil, mappedKey{}, false
}

func (d *Daemon) isPreloadedChar(char rune) bool {
	_, _, ok := d.lookupPreloadedChar(char)
	return ok
}

func (d *Daemon) cancelIdleFlush() {
	atomic.AddUint64(&d.idleFlushSeq, 1)
}

func adaptiveDelay(gap, minGap, maxGap, fastValue, slowValue time.Duration) time.Duration {
	if gap <= minGap {
		return fastValue
	}
	if gap >= maxGap {
		return slowValue
	}
	span := int64(maxGap - minGap)
	offset := int64(gap - minGap)
	fast := int64(fastValue)
	slow := int64(slowValue)
	return time.Duration(fast + (slow-fast)*offset/span)
}

func (d *Daemon) updateTypingCadence() {
	now := time.Now()
	if d.lastTypingAt.IsZero() {
		d.lastKeyGap = adaptiveMaxKeyGap
	} else {
		d.lastKeyGap = now.Sub(d.lastTypingAt)
	}
	d.lastTypingAt = now
}

func (d *Daemon) currentPreviewInterval() time.Duration {
	return adaptiveDelay(d.lastKeyGap, adaptiveMinKeyGap, adaptiveMaxKeyGap, maxPreviewInterval, minPreviewInterval)
}

func (d *Daemon) currentIdleFlushDelay() time.Duration {
	return adaptiveDelay(d.lastKeyGap, adaptiveMinKeyGap, adaptiveMaxKeyGap, maxIdleFlushDelay, minIdleFlushDelay)
}

func (d *Daemon) currentPendingChar() (rune, bool) {
	switch d.hangul.state {
	case stateChoseong:
		return choseongToJamo[d.hangul.cho], true
	case stateJungseong:
		return composeSyllable(d.hangul.cho, d.hangul.jung, 0), true
	case stateJongseong:
		return composeSyllable(d.hangul.cho, d.hangul.jung, d.hangul.jong), true
	default:
		return 0, false
	}
}

func (d *Daemon) showPending() {
	char, ok := d.currentPendingChar()
	if !ok {
		return
	}
	if d.pendingVisible && d.visibleChar == char {
		return
	}
	d.commitPendingChar(char)
}

func (d *Daemon) maybePreviewCurrent() {
	char, ok := d.currentPendingChar()
	if !ok {
		return
	}
	if d.isPreloadedChar(char) {
		if !d.pendingVisible || d.visibleChar != char {
			d.commitPendingChar(char)
		} else {
			d.scheduleIdleFlush()
		}
		return
	}
	previewInterval := d.currentPreviewInterval()
	if !d.pendingVisible {
		if d.lastPreviewAt.IsZero() || time.Since(d.lastPreviewAt) >= previewInterval {
			d.commitPendingChar(char)
		} else {
			d.scheduleIdleFlush()
		}
		return
	}
	if d.visibleChar == char {
		d.scheduleIdleFlush()
		return
	}
	if time.Since(d.lastPreviewAt) >= previewInterval {
		d.commitPendingChar(char)
	} else {
		d.scheduleIdleFlush()
	}
}

func (d *Daemon) scheduleIdleFlush() {
	if d.hangul.state == stateEmpty {
		return
	}
	seq := atomic.AddUint64(&d.idleFlushSeq, 1)
	delay := d.currentIdleFlushDelay()
	go func(expected uint64, delay time.Duration) {
		time.Sleep(delay)
		if atomic.LoadUint64(&d.idleFlushSeq) != expected {
			return
		}
		d.mu.Lock()
		defer d.mu.Unlock()
		if atomic.LoadUint64(&d.idleFlushSeq) != expected {
			return
		}
		if d.hangul.state == stateEmpty {
			return
		}
		d.showPending()
	}(seq, delay)
}

func (d *Daemon) resetCompose() {
	d.cancelIdleFlush()
	d.hangul = HangulState{}
	d.pendingVisible = false
	d.visibleChar = 0
}

func (d *Daemon) commitPendingChar(char rune) {
	backspaces := 0
	if d.pendingVisible {
		backspaces = 1
	}
	d.outputChar(char, backspaces, true)
	d.pendingVisible = true
	d.visibleChar = char
	d.lastPreviewAt = time.Now()
}

func (d *Daemon) renderBackspaceStep(char rune) {
	backspaces := 0
	if d.pendingVisible {
		backspaces = 1
	}
	d.outputChar(char, backspaces, false)
	d.pendingVisible = true
	d.visibleChar = char
	d.lastPreviewAt = time.Now()
}

func (d *Daemon) commitCurrent() {
	if char, ok := d.currentPendingChar(); ok {
		if !d.pendingVisible || d.visibleChar != char {
			d.commitPendingChar(char)
		}
	}
	d.resetCompose()
}

func (d *Daemon) beginDeferredChoseong(choIdx int) {
	d.hangul.cho = choIdx
	d.hangul.jung = 0
	d.hangul.jong = 0
	d.hangul.state = stateChoseong
	d.pendingVisible = false
	d.visibleChar = 0
	d.scheduleIdleFlush()
}

func isAlphaKey(code uint16) bool {
	return (code >= KEY_Q && code <= KEY_P) ||
		(code >= KEY_A && code <= KEY_L) ||
		(code >= KEY_Z && code <= KEY_M)
}

func (d *Daemon) handleKoreanKey(keyCode uint16, pressed bool) {
	if !pressed {
		return
	}

	d.updateTypingCadence()

	choIdx := -1
	jungIdx := -1
	jongIdx := -1
	isChoseong := false
	isJungseong := false

	if d.shifted {
		if idx := choseongShiftMap[keyCode]; idx != invalidIndex8 {
			isChoseong = true
			choIdx = int(idx)
		} else if idx := jungseongShiftMap[keyCode]; idx != invalidIndex8 {
			isJungseong = true
			jungIdx = int(idx)
		} else if idx := choseongMap[keyCode]; idx != invalidIndex8 {
			isChoseong = true
			choIdx = int(idx)
		} else if idx := jungseongMap[keyCode]; idx != invalidIndex8 {
			isJungseong = true
			jungIdx = int(idx)
		}
		if isChoseong {
			if idx := jongseongShiftMap[keyCode]; idx != invalidIndex8 {
				jongIdx = int(idx)
			}
		}
	} else {
		if idx := choseongMap[keyCode]; idx != invalidIndex8 {
			isChoseong = true
			choIdx = int(idx)
			if idx2 := jongseongMap[keyCode]; idx2 != invalidIndex8 {
				jongIdx = int(idx2)
			}
		}
		if idx := jungseongMap[keyCode]; idx != invalidIndex8 {
			isJungseong = true
			jungIdx = int(idx)
		}
	}

	if !isChoseong && !isJungseong {
		d.commitCurrent()
		d.sendKeyTap(keyCode)
		return
	}

	switch d.hangul.state {
	case stateEmpty:
		if isChoseong {
			d.hangul.cho = choIdx
			d.hangul.state = stateChoseong
			d.pendingVisible = false
			d.maybePreviewCurrent()
		} else if isJungseong {
			d.outputChar(jungseongToJamo[jungIdx], 0, false)
			d.resetCompose()
		}

	case stateChoseong:
		if isJungseong {
			d.hangul.jung = jungIdx
			d.hangul.state = stateJungseong
			d.maybePreviewCurrent()
		} else if isChoseong {
			d.renderBackspaceStep(choseongToJamo[d.hangul.cho])
			d.hangul.cho = choIdx
			d.hangul.state = stateChoseong
			d.pendingVisible = false
			d.maybePreviewCurrent()
		}

	case stateJungseong:
		if isChoseong && jongIdx >= 0 {
			d.hangul.jong = jongIdx
			d.hangul.state = stateJongseong
			d.scheduleIdleFlush()
		} else if isJungseong {
			compoundJung := getCompoundJungseong(d.hangul.jung, jungIdx)
			if compoundJung >= 0 {
				d.hangul.jung = compoundJung
				d.maybePreviewCurrent()
			} else {
				d.commitCurrent()
				d.outputChar(jungseongToJamo[jungIdx], 0, false)
				d.resetCompose()
			}
		} else if isChoseong {
			d.commitCurrent()
			d.beginDeferredChoseong(choIdx)
		}

	case stateJongseong:
		if isJungseong {
			if split := splitCompoundJongseong(d.hangul.jong); split.ok {
				newCho := int(jongseongToChoseong[split.second])
				d.hangul.jong = int(split.first)
				d.commitCurrent()
				d.hangul.cho = newCho
				d.hangul.jung = jungIdx
				d.hangul.jong = 0
				d.hangul.state = stateJungseong
				d.pendingVisible = false
				d.maybePreviewCurrent()
			} else {
				newCho := int(jongseongToChoseong[d.hangul.jong])
				d.hangul.jong = 0
				d.commitCurrent()
				d.hangul.cho = newCho
				d.hangul.jung = jungIdx
				d.hangul.jong = 0
				d.hangul.state = stateJungseong
				d.pendingVisible = false
				d.maybePreviewCurrent()
			}
		} else if isChoseong && jongIdx >= 0 {
			if compound := getCompoundJongseong(d.hangul.jong, jongIdx); compound >= 0 {
				d.hangul.jong = compound
				d.scheduleIdleFlush()
			} else {
				d.commitCurrent()
				d.beginDeferredChoseong(choIdx)
			}
		} else if isChoseong {
			d.commitCurrent()
			d.beginDeferredChoseong(choIdx)
		}
	}
}

func (d *Daemon) handleBackspace() {
	switch d.hangul.state {
	case stateJongseong:
		if split := splitCompoundJongseong(d.hangul.jong); split.ok {
			d.hangul.jong = int(split.first)
		} else {
			d.hangul.jong = 0
			d.hangul.state = stateJungseong
		}
		d.renderBackspaceStep(composeSyllable(d.hangul.cho, d.hangul.jung, d.hangul.jong))
	case stateJungseong:
		if split := splitCompoundJungseong(d.hangul.jung); split.ok {
			d.hangul.jung = int(split.first)
			d.renderBackspaceStep(composeSyllable(d.hangul.cho, d.hangul.jung, 0))
		} else {
			d.hangul.jung = 0
			d.hangul.state = stateChoseong
			d.renderBackspaceStep(choseongToJamo[d.hangul.cho])
		}
	case stateChoseong:
		if d.pendingVisible {
			d.sendBackspace()
		}
		d.resetCompose()
	}
}

func (d *Daemon) handleEvent(ev InputEvent) {
	if ev.Type != EV_KEY {
		d.passthrough(ev)
		return
	}
	// Shift 상태 체크
	if ev.Code == KEY_LEFTSHIFT || ev.Code == KEY_RIGHTSHIFT {
		d.shifted = (ev.Value != keyRelease)
		d.passthrough(ev)
		return
	}
	// Ctrl Alt 상태 체크
	if ev.Code == KEY_LEFTCTRL || ev.Code == KEY_LEFTALT {
		if ev.Value == keyPress {
			d.ctrl_or_alt = true
			d.commitCurrent() // 한글 조합 중이면 확정
			d.restoreKeymap()
		} else if ev.Value == keyRelease {
			d.ctrl_or_alt = false
		}
		d.passthrough(ev)
		return
	}

	// CapsLock 한영 모드 전환
	if ev.Code == KEY_CAPSLOCK {
		if ev.Value == keyPress {
			d.commitCurrent()
			d.restoreKeymap()
			d.korean = !d.korean
			if d.korean {
				log.Println("모드: 한글")
			} else {
				log.Println("모드: 영문")
			}
		}
		return
	}

	// Ctrl or Alt가 눌린 동안은 무조건 우회
	if d.ctrl_or_alt {
		d.passthrough(ev)
		return
	}

	// 영문 모드면 그대로 전달
	if !d.korean {
		d.passthrough(ev)
		return
	}

	if ev.Value == keyPress || ev.Value == keyRepeat {
		if isAlphaKey(ev.Code) {
			d.handleKoreanKey(ev.Code, true)
			return
		}
		if ev.Code == KEY_SPACE || ev.Code == KEY_ENTER || ev.Code == KEY_TAB {
			d.commitCurrent()
			d.passthrough(ev)
			return
		}
		if ev.Code == KEY_BACKSPACE {
			if d.hangul.state != stateEmpty {
				d.handleBackspace()
				return
			}
			d.passthrough(ev)
			return
		}
		d.commitCurrent()
		d.passthrough(ev)
		return
	}

	if ev.Value == keyRelease && isAlphaKey(ev.Code) {
		return
	}

	d.passthrough(ev)
}

func findBTKeyboard() (string, error) {
	entries, err := os.ReadDir("/dev/input")
	if err != nil {
		return "", fmt.Errorf("readdir /dev/input: %w", err)
	}

	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "event") {
			continue
		}
		devPath := "/dev/input/" + entry.Name()

		num := strings.TrimPrefix(entry.Name(), "event")
		nameFile := fmt.Sprintf("/sys/class/input/event%s/device/name", num)
		nameBytes, err := os.ReadFile(nameFile)
		if err != nil {
			continue
		}
		name := strings.TrimSpace(string(nameBytes))
		log.Printf("입력 디바이스 발견: %s = %s", devPath, name)

		lowerName := strings.ToLower(strings.TrimSpace(name))
		if lowerName == "" {
			continue
		}
		busTypeBytes, err := os.ReadFile(fmt.Sprintf("/sys/class/input/event%s/device/id/bustype", num))
		busType := ""
		if err == nil {
			busType = strings.TrimSpace(string(busTypeBytes))
		}
		skip := false
		for _, term := range []string{"hangul", "gpio", "pwrkey", "power", "button", "touchscreen", "touch", "stylus", "wacom", "pen", "hall", "sensor", "marker"} {
			if strings.Contains(lowerName, term) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		if busType != "0005" &&
			!strings.Contains(lowerName, "keyboard") &&
			!strings.Contains(lowerName, "keys") &&
			!strings.Contains(lowerName, "keychron") &&
			!strings.Contains(lowerName, "hhkb") &&
			!strings.Contains(lowerName, "magic keyboard") &&
			!strings.Contains(lowerName, "mx keys") &&
			!strings.Contains(lowerName, "k380") &&
			!strings.Contains(lowerName, "k780") {
			continue
		}

		{
			log.Printf("BT 키보드 선택: %s (%s)", devPath, name)
			return devPath, nil
		}
	}

	return "", fmt.Errorf("BT keyboard not found in /dev/input")
}

func findXochitlPID() (int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, fmt.Errorf("readdir /proc: %w", err)
	}

	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
		if err != nil {
			continue
		}
		if strings.TrimSpace(string(comm)) == "xochitl" {
			return pid, nil
		}
	}

	return 0, fmt.Errorf("xochitl process not found")
}

func (d *Daemon) openAndGrab(devicePath string) error {
	f, err := os.OpenFile(devicePath, os.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", devicePath, err)
	}
	d.inputFd = f

	if err := ioctl(f.Fd(), EVIOCGRAB, 1); err != nil {
		f.Close()
		d.inputFd = nil
		return fmt.Errorf("EVIOCGRAB: %w", err)
	}
	log.Printf("독점 grab: %s", devicePath)
	return nil
}

func (d *Daemon) closeInput() {
	if d.inputFd != nil {
		_ = ioctl(d.inputFd.Fd(), EVIOCGRAB, 0)
		d.inputFd.Close()
		d.inputFd = nil
	}
}

func waitForKeyboard() string {
	for {
		path, err := findBTKeyboard()
		if err == nil {
			return path
		}
		time.Sleep(2 * time.Second)
	}
}

func (d *Daemon) run(devicePath string) error {
	// 패처 초기화 (디스크에서 KEY_Q 오프셋 검색)
	d.patcher = &KeymapPatcher{}
	if err := d.patcher.init(); err != nil {
		return fmt.Errorf("patcher init: %w", err)
	}

	// xochitl 실행 확인
	if pid, err := findXochitlPID(); err != nil {
		log.Printf("경고: xochitl 미실행 (%v)", err)
	} else {
		log.Printf("xochitl PID: %d", pid)
	}

	// 기본 영문 uinput 디바이스 생성
	if err := d.setupUinput(); err != nil {
		return fmt.Errorf("setup uinput: %w", err)
	}
	if err := d.setupPreloadedKeyboards(); err != nil {
		return fmt.Errorf("setup preloaded keyboards: %w", err)
	}

	d.korean = true
	log.Println("모드: 한글 (CapsLock으로 전환)")

	currentPath := devicePath

	for {
		if err := d.openAndGrab(currentPath); err != nil {
			log.Printf("키보드 열기 실패: %v", err)
			log.Println("BT 키보드 재연결 대기 중...")
			currentPath = waitForKeyboard()
			continue
		}

		log.Printf("이벤트 루프 시작: %s", currentPath)
		err := d.eventLoop()
		d.closeInput()

		if err != nil {
			log.Printf("이벤트 루프 오류: %v", err)
			log.Println("BT 키보드 재연결 대기 중...")
			d.commitCurrent()
			currentPath = waitForKeyboard()
		}
	}
}

func (d *Daemon) eventLoop() error {
	fd := int(d.inputFd.Fd())
	var buf [inputEventSize]byte
	eventCount := 0
	for {
		n, err := syscall.Read(fd, buf[:])
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if n != inputEventSize {
			continue
		}

		var ev InputEvent
		ev.Type = binary.LittleEndian.Uint16(buf[16:18])
		ev.Code = binary.LittleEndian.Uint16(buf[18:20])
		ev.Value = int32(binary.LittleEndian.Uint32(buf[20:24]))

		eventCount++
		if debugLogging && (eventCount <= 10 || ev.Type == EV_KEY) {
			log.Printf("[EVT] #%d type=%d code=%d val=%d", eventCount, ev.Type, ev.Code, ev.Value)
		}

		d.mu.Lock()
		d.handleEvent(ev)
		d.mu.Unlock()
	}
}

func (d *Daemon) cleanup() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.closeInput()
	if d.uinputFd != nil {
		_ = ioctl(d.uinputFd.Fd(), UI_DEV_DESTROY, 0)
		d.uinputFd.Close()
	}
	for i := range d.preloadedKeyboards {
		if d.preloadedKeyboards[i].fd != nil {
			_ = ioctl(d.preloadedKeyboards[i].fd.Fd(), UI_DEV_DESTROY, 0)
			_ = d.preloadedKeyboards[i].fd.Close()
		}
	}
	d.preloadedKeyboards = nil
	if d.patcher != nil {
		d.patcher.restoreDisk()
	}
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	log.Printf("Hangul Keyboard Daemon v2 시작 (디바이스 재생성 방식)")

	devicePath := ""
	if len(os.Args) > 1 {
		devicePath = os.Args[1]
	} else {
		log.Println("BT 키보드 탐색 중...")
		devicePath = waitForKeyboard()
	}

	log.Printf("디바이스: %s", devicePath)

	d := &Daemon{}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("종료 중...")
		d.cleanup()
		os.Exit(0)
	}()

	if err := d.run(devicePath); err != nil {
		d.cleanup()
		log.Fatal(err)
	}
}
