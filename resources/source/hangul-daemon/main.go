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
	KEY_1          = 2
	KEY_2          = 3
	KEY_3          = 4
	KEY_4          = 5
	KEY_5          = 6
	KEY_6          = 7
	KEY_7          = 8
	KEY_8          = 9
	KEY_9          = 10
	KEY_0          = 11
	KEY_EQUAL      = 13
	KEY_BACKSPACE  = 14
	KEY_Q          = 16
	KEY_W          = 17
	KEY_E          = 18
	KEY_R          = 19
	KEY_T          = 20
	KEY_Y          = 21
	KEY_U          = 22
	KEY_I          = 23
	KEY_O          = 24
	KEY_P          = 25
	KEY_LEFTBRACE  = 26
	KEY_RIGHTBRACE = 27
	KEY_ENTER      = 28
	KEY_LEFTCTRL   = 29
	KEY_A          = 30
	KEY_S          = 31
	KEY_D          = 32
	KEY_F          = 33
	KEY_G          = 34
	KEY_H          = 35
	KEY_J          = 36
	KEY_K          = 37
	KEY_L          = 38
	KEY_SEMICOLON  = 39
	KEY_APOSTROPHE = 40
	KEY_GRAVE      = 41
	KEY_LEFTSHIFT  = 42
	KEY_BACKSLASH  = 43
	KEY_Z          = 44
	KEY_X          = 45
	KEY_C          = 46
	KEY_V          = 47
	KEY_B          = 48
	KEY_N          = 49
	KEY_M          = 50
	KEY_COMMA      = 51
	KEY_DOT        = 52
	KEY_SLASH      = 53
	KEY_RIGHTSHIFT = 54
	KEY_LEFTALT    = 56
	KEY_RIGHTALT   = 100
	KEY_SPACE      = 57
	KEY_CAPSLOCK   = 58
	KEY_TAB        = 15

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
	minIdleFlushDelay      = 100 * time.Millisecond
	maxIdleFlushDelay      = 260 * time.Millisecond
	adaptiveMinKeyGap      = 40 * time.Millisecond
	adaptiveMaxKeyGap      = 400 * time.Millisecond
	virtualKeyboardName    = "Hangul Virtual Keyboard"
	uinputReadyTimeout     = 1500 * time.Millisecond
	maxOutputBatchJobs     = 64
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

type outputSlotState int

const (
	outputSlotFree outputSlotState = iota
	outputSlotResident
	outputSlotPreviewVisible
	outputSlotReservedCommit
)

type outputSlot struct {
	spec     keyPatchSpec
	char     rune
	lastUsed uint64
	state    outputSlotState
}

type DeviceInfo struct {
	Path    string
	Name    string
	BusType string
}

type ManagedInput struct {
	Info DeviceInfo
	File *os.File
}

type InputMessage struct {
	Path  string
	Event InputEvent
	Err   error
}

type outputEvent struct {
	typ   uint16
	code  uint16
	value int32
}

type outputJobKind int

const (
	outputJobEmitSequence outputJobKind = iota
	outputJobPreviewRender
	outputJobCommitRender
	outputJobSyncLayout
	outputJobRestoreLayout
)

type outputJob struct {
	kind        outputJobKind
	sequence    []outputEvent
	layout      []outputSlot
	slotIndex   int
	spec        keyPatchSpec
	char        rune
	generation  uint64
	visibleAtEnqueue bool
	needsPatch  bool
	releaseSlot bool
}

type outputResult struct {
	releaseSlots []int
	previewShown bool
	char         rune
	generation   uint64
}

type renderBatchMeta struct {
	hasCommit bool
	jobCount  int
}

type outputSlotSnapshot struct {
	prevChar     rune
	prevLastUsed uint64
	prevTick     uint64
	prevState    outputSlotState
}

type outputSlotBinding struct {
	slotIndex   int
	key         mappedKey
	snapshot    outputSlotSnapshot
	patchNeeded bool
}

type idleFlushCommand struct {
	seq    uint64
	delay  time.Duration
	cancel bool
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
	file        *os.File
	mapped      []byte
	mappedOffset int64
	rangeReady  bool
	rangeMinOff int64
	rangeMaxEnd int64
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

func (kp *KeymapPatcher) close() {
	if kp.mapped != nil {
		_ = syscall.Munmap(kp.mapped)
		kp.mapped = nil
		kp.mappedOffset = 0
	}
	if kp.file != nil {
		_ = kp.file.Close()
		kp.file = nil
	}
}

func (kp *KeymapPatcher) requiredMapRange() (int64, int64, error) {
	if kp.rangeReady {
		return kp.rangeMinOff, kp.rangeMaxEnd, nil
	}
	var minOff int64 = -1
	var maxEnd int64
	appendRange := func(offsets []int64) {
		for _, off := range offsets {
			if minOff == -1 || off < minOff {
				minOff = off
			}
			if end := off + 8; end > maxEnd {
				maxEnd = end
			}
		}
	}
	appendRange(kp.fileOffsets)
	for _, entry := range kp.keyEntries {
		appendRange(entry.fileOffsets)
	}
	if minOff < 0 || maxEnd <= minOff {
		return 0, 0, fmt.Errorf("no keymap offsets available")
	}
	kp.rangeReady = true
	kp.rangeMinOff = minOff
	kp.rangeMaxEnd = maxEnd
	return minOff, maxEnd, nil
}

func (kp *KeymapPatcher) openMappedFile() error {
	minOff, maxEnd, err := kp.requiredMapRange()
	if err != nil {
		return err
	}
	pageSize := int64(os.Getpagesize())
	mapStart := minOff & ^(pageSize - 1)
	mapEnd := maxEnd
	if rem := mapEnd % pageSize; rem != 0 {
		mapEnd += pageSize - rem
	}
	mapLen := int(mapEnd - mapStart)
	if kp.file != nil && kp.mapped != nil && kp.mappedOffset == mapStart && len(kp.mapped) == mapLen {
		return nil
	}
	kp.close()

	f, err := os.OpenFile(kp.diskPath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", kp.diskPath, err)
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("stat %s: %w", kp.diskPath, err)
	}
	if fi.Size() == 0 {
		f.Close()
		return fmt.Errorf("%s is empty", kp.diskPath)
	}
	if mapEnd > fi.Size() {
		f.Close()
		return fmt.Errorf("keymap range out of bounds: start=0x%x end=0x%x size=0x%x", mapStart, mapEnd, fi.Size())
	}
	mapped, err := syscall.Mmap(int(f.Fd()), mapStart, mapLen, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		f.Close()
		return fmt.Errorf("mmap %s [0x%x,0x%x): %w", kp.diskPath, mapStart, mapEnd, err)
	}
	kp.file = f
	kp.mapped = mapped
	kp.mappedOffset = mapStart
	return nil
}

func (kp *KeymapPatcher) findSignatureOffsets(signature []byte) ([]int64, error) {
	return searchFileForSignature(kp.diskPath, signature)
}

func searchFileForSignature(path string, signature []byte) ([]int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	fileSize := fi.Size()
	if len(signature) == 0 || fileSize < int64(len(signature)) {
		return nil, nil
	}

	var offsets []int64
	buf := make([]byte, 4096)
	sigLen := int64(len(signature))

	for off := int64(0); off < fileSize; off += int64(len(buf)) - sigLen {
		readSize := int64(len(buf))
		if off+readSize > fileSize {
			readSize = fileSize - off
		}
		n, readErr := f.ReadAt(buf[:readSize], off)
		if readErr != nil && readErr != io.EOF {
			return nil, readErr
		}
		if int64(n) < sigLen {
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
	return offsets, nil
}

func (kp *KeymapPatcher) init() error {
	kp.diskPath = "/usr/lib/plugins/platforms/libepaper.so"
	backupPath := "/tmp/libepaper.so.original"

	// KEY_Q plain 엔트리 시그니처: keycode=0x10, unicode='q', qtcode=Qt::Key_Q, mod=0
	signature := []byte{0x10, 0x00, 0x71, 0x00, 0x51, 0x00, 0x00, 0x00, 0x00}

	offsets, err := kp.findSignatureOffsets(signature)
	if err != nil {
		return fmt.Errorf("cannot scan %s: %w", kp.diskPath, err)
	}
	kp.fileOffsets = offsets
	kp.rangeReady = false

	if len(kp.fileOffsets) == 0 {
		// 이전 세션에서 패치된 상태일 수 있음 → 백업에서 복원
		if _, err := os.Stat(backupPath); err == nil {
			log.Println("[PATCHER] 이전 패치 감지, 백업에서 복원 중...")
			kp.close()
			if err := copyFile(backupPath, kp.diskPath); err != nil {
				return fmt.Errorf("backup restore failed: %w", err)
			}
			offsets, err = kp.findSignatureOffsets(signature)
			if err != nil {
				return fmt.Errorf("cannot scan %s after restore: %w", kp.diskPath, err)
			}
			kp.fileOffsets = offsets
			kp.rangeReady = false
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

	return nil
}

func (kp *KeymapPatcher) writeToDisk(unicode uint16, qtcode uint32) error {
	if err := kp.openMappedFile(); err != nil {
		return err
	}

	var uniBuf [2]byte
	binary.LittleEndian.PutUint16(uniBuf[:], unicode)
	var qtBuf [4]byte
	binary.LittleEndian.PutUint32(qtBuf[:], qtcode)

	for _, fOff := range kp.fileOffsets {
		uniOff := fOff + 2
		qtOff := fOff + 4
		localUniOff := uniOff - kp.mappedOffset
		localQtOff := qtOff - kp.mappedOffset
		if localUniOff < 0 || localQtOff+4 > int64(len(kp.mapped)) {
			return fmt.Errorf("write range out of bounds at 0x%x", fOff)
		}
		copy(kp.mapped[localUniOff:localUniOff+2], uniBuf[:])
		copy(kp.mapped[localQtOff:localQtOff+4], qtBuf[:])
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

func keyEntryKey(code uint16, mod byte) uint32 {
	return uint32(code)<<8 | uint32(mod)
}

func mappedKeyFromSpec(spec keyPatchSpec) mappedKey {
	return mappedKey{code: spec.code, shifted: spec.mod != 0}
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

func digitPlainSpecs() []keyPatchSpec {
	return nil
}

func digitShiftSpecs() []keyPatchSpec {
	return nil
}

func alphaPlainSpecs() []keyPatchSpec {
	return []keyPatchSpec{
		{KEY_Q, 'q', 'Q', 0}, {KEY_W, 'w', 'W', 0}, {KEY_E, 'e', 'E', 0}, {KEY_R, 'r', 'R', 0},
		{KEY_T, 't', 'T', 0}, {KEY_Y, 'y', 'Y', 0}, {KEY_U, 'u', 'U', 0}, {KEY_I, 'i', 'I', 0},
		{KEY_O, 'o', 'O', 0}, {KEY_P, 'p', 'P', 0}, {KEY_A, 'a', 'A', 0}, {KEY_S, 's', 'S', 0},
		{KEY_D, 'd', 'D', 0}, {KEY_F, 'f', 'F', 0}, {KEY_G, 'g', 'G', 0}, {KEY_H, 'h', 'H', 0},
		{KEY_J, 'j', 'J', 0}, {KEY_K, 'k', 'K', 0}, {KEY_L, 'l', 'L', 0}, {KEY_Z, 'z', 'Z', 0},
		{KEY_X, 'x', 'X', 0}, {KEY_C, 'c', 'C', 0}, {KEY_V, 'v', 'V', 0}, {KEY_B, 'b', 'B', 0},
		{KEY_N, 'n', 'N', 0}, {KEY_M, 'm', 'M', 0},
	}
}

func alphaShiftSpecs() []keyPatchSpec {
	return []keyPatchSpec{
		{KEY_Q, 'Q', 'Q', 1}, {KEY_W, 'W', 'W', 1}, {KEY_E, 'E', 'E', 1}, {KEY_R, 'R', 'R', 1},
		{KEY_T, 'T', 'T', 1}, {KEY_Y, 'Y', 'Y', 1}, {KEY_U, 'U', 'U', 1}, {KEY_I, 'I', 'I', 1},
		{KEY_O, 'O', 'O', 1}, {KEY_P, 'P', 'P', 1}, {KEY_A, 'A', 'A', 1}, {KEY_S, 'S', 'S', 1},
		{KEY_D, 'D', 'D', 1}, {KEY_F, 'F', 'F', 1}, {KEY_G, 'G', 'G', 1}, {KEY_H, 'H', 'H', 1},
		{KEY_J, 'J', 'J', 1}, {KEY_K, 'K', 'K', 1}, {KEY_L, 'L', 'L', 1}, {KEY_Z, 'Z', 'Z', 1},
		{KEY_X, 'X', 'X', 1}, {KEY_C, 'C', 'C', 1}, {KEY_V, 'V', 'V', 1}, {KEY_B, 'B', 'B', 1},
		{KEY_N, 'N', 'N', 1}, {KEY_M, 'M', 'M', 1},
	}
}

func symbolPlainSpecs() []keyPatchSpec { return nil }

func symbolShiftSpecs() []keyPatchSpec { return nil }

func allOutputSlotSpecs() []keyPatchSpec {
	specs := make([]keyPatchSpec, 0, 52)
	specs = append(specs, alphaPlainSpecs()...)
	specs = append(specs, alphaShiftSpecs()...)
	return specs
}

func (kp *KeymapPatcher) initKeyEntry(spec keyPatchSpec) error {
	if kp.keyEntries == nil {
		kp.keyEntries = make(map[uint32]keyPatchInfo)
	}
	entryKey := keyEntryKey(spec.code, spec.mod)
	if _, ok := kp.keyEntries[entryKey]; ok {
		return nil
	}

	signature := make([]byte, 9)
	binary.LittleEndian.PutUint16(signature[0:2], spec.code)
	binary.LittleEndian.PutUint16(signature[2:4], spec.unicode)
	binary.LittleEndian.PutUint32(signature[4:8], spec.qtcode)
	signature[8] = spec.mod

	offsets, err := kp.findSignatureOffsets(signature)
	if err != nil {
		return err
	}
	if len(offsets) == 0 {
		return fmt.Errorf("key entry not found: code=%d unicode=U+%04X qt=0x%08x mod=%d", spec.code, spec.unicode, spec.qtcode, spec.mod)
	}

	kp.keyEntries[entryKey] = keyPatchInfo{
		fileOffsets: offsets,
		origUnicode: spec.unicode,
		origQtcode:  spec.qtcode,
	}
	kp.rangeReady = false
	return nil
}

func (kp *KeymapPatcher) writeKeyEntryToDisk(code uint16, mod byte, unicode uint16, qtcode uint32) error {
	entry, ok := kp.keyEntries[keyEntryKey(code, mod)]
	if !ok {
		return fmt.Errorf("uninitialized key entry: %s shift=%t", keyCodeName(code), mod != 0)
	}
	if err := kp.openMappedFile(); err != nil {
		return err
	}

	var uniBuf [2]byte
	binary.LittleEndian.PutUint16(uniBuf[:], unicode)
	var qtBuf [4]byte
	binary.LittleEndian.PutUint32(qtBuf[:], qtcode)

	for _, fOff := range entry.fileOffsets {
		uniOff := fOff + 2
		qtOff := fOff + 4
		localUniOff := uniOff - kp.mappedOffset
		localQtOff := qtOff - kp.mappedOffset
		if localUniOff < 0 || localQtOff+4 > int64(len(kp.mapped)) {
			return fmt.Errorf("write range out of bounds at 0x%x", fOff)
		}
		copy(kp.mapped[localUniOff:localUniOff+2], uniBuf[:])
		copy(kp.mapped[localQtOff:localQtOff+4], qtBuf[:])
	}
	return nil
}

func (kp *KeymapPatcher) restoreKeyEntry(code uint16, mod byte) error {
	entry, ok := kp.keyEntries[keyEntryKey(code, mod)]
	if !ok {
		return fmt.Errorf("uninitialized key entry: %s shift=%t", keyCodeName(code), mod != 0)
	}
	return kp.writeKeyEntryToDisk(code, mod, entry.origUnicode, entry.origQtcode)
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
	mu             sync.Mutex
	inputs         map[string]*ManagedInput
	inputCh        chan InputMessage
	rescanCh       chan struct{}
	outputCh       chan outputJob
	outputResultCh chan outputResult
	outputStopCh   chan struct{}
	outputWg       sync.WaitGroup
	uinputFd       *os.File
	korean         bool
	shifted        bool
	shiftForwarded bool
	shiftSpaceTogglePending bool
	ctrl_or_alt    bool
	pendingVisible bool
	visibleChar    rune
	previewPending bool
	previewChar    rune
	composeGeneration uint64
	pendingMiss    bool
	pendingMissChar rune
	lastTypingAt   time.Time
	lastKeyGap     time.Duration
	hangul         HangulState
	patcher        *KeymapPatcher
	idleFlushSeq   uint64
	idleFlushCmdCh chan idleFlushCommand
	outputMap      map[rune]mappedKey
	outputIndex    map[rune]int
	outputSpecs    []keyPatchSpec
	outputSlots    []outputSlot
	composeSlotActive bool
	composeSlotIndex  int
	renderLatestJobs     []outputJob
	renderLatestSet      []bool
	renderDroppedPreview []bool
	renderReleaseSet     []bool
	renderOrder          []int
	renderFiltered       []outputJob
	renderTouchedDropped []int
	renderReleaseSlots   []int
	layoutActive   bool
	lruUseTick     uint64
}

func ioctl(fd uintptr, request uintptr, arg uintptr) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, request, arg)
	if errno != 0 {
		return errno
	}
	return nil
}

func (d *Daemon) setupUinput() error {
	f, err := os.OpenFile("/dev/uinput", os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("open /dev/uinput: %w", err)
	}
	d.uinputFd = f
	fd := f.Fd()

	if err := ioctl(fd, UI_SET_EVBIT, uintptr(EV_KEY)); err != nil {
		return fmt.Errorf("UI_SET_EVBIT: %w", err)
	}
	if err := ioctl(fd, UI_SET_EVBIT, uintptr(EV_SYN)); err != nil {
		return fmt.Errorf("UI_SET_EVBIT SYN: %w", err)
	}
	for i := uintptr(0); i < 256; i++ {
		if err := ioctl(fd, UI_SET_KEYBIT, i); err != nil {
			return fmt.Errorf("UI_SET_KEYBIT %d: %w", i, err)
		}
	}

	setup := UinputSetup{
		ID: InputID{Bustype: BUS_USB, Vendor: 0x1234, Product: 0x5678, Version: 1},
	}
	copy(setup.Name[:], "Hangul Virtual Keyboard")

	if err := ioctl(fd, UI_DEV_SETUP, uintptr(unsafe.Pointer(&setup))); err != nil {
		return fmt.Errorf("UI_DEV_SETUP: %w", err)
	}
	if err := ioctl(fd, UI_DEV_CREATE, 0); err != nil {
		return fmt.Errorf("UI_DEV_CREATE: %w", err)
	}

	return nil
}

func findVirtualKeyboardEventPaths() ([]string, error) {
	entries, err := os.ReadDir("/sys/class/input")
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0, 1)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "event") {
			continue
		}
		nameBytes, err := os.ReadFile("/sys/class/input/" + entry.Name() + "/device/name")
		if err != nil {
			continue
		}
		if strings.TrimSpace(string(nameBytes)) != virtualKeyboardName {
			continue
		}
		paths = append(paths, "/dev/input/"+entry.Name())
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("virtual keyboard event node not found")
	}
	return paths, nil
}

func processHasOpenPath(pid int, target string) bool {
	entries, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if err != nil {
		return false
	}
	for _, entry := range entries {
		linkTarget, err := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", pid, entry.Name()))
		if err != nil {
			continue
		}
		if linkTarget == target {
			return true
		}
	}
	return false
}

func (d *Daemon) waitForUinputReady(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		pid, err := findXochitlPID()
		if err == nil {
			paths, pathErr := findVirtualKeyboardEventPaths()
			if pathErr == nil {
				for _, path := range paths {
					if processHasOpenPath(pid, path) {
						return nil
					}
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("xochitl did not open %q within %s", virtualKeyboardName, timeout)
}

// recreateUinput: uinput 디바이스를 파괴하고 재생성
// xochitl이 새 핸들러를 생성하며, 이때 디스크의 (패치된) 키맵을 로드
func (d *Daemon) recreateUinput() error {
	if d.uinputFd != nil {
		_ = ioctl(d.uinputFd.Fd(), UI_DEV_DESTROY, 0)
		d.uinputFd.Close()
		d.uinputFd = nil
	}

	if err := d.setupUinput(); err != nil {
		return fmt.Errorf("recreate uinput: %w", err)
	}

	if _, err := findXochitlPID(); err != nil {
		time.Sleep(80 * time.Millisecond)
		return nil
	}
	if err := d.waitForUinputReady(uinputReadyTimeout); err != nil {
		log.Printf("[UINPUT] ready wait timed out: %v", err)
	}

	return nil
}

func (d *Daemon) writeEvent(typ uint16, code uint16, value int32) error {
	var buf [inputEventSize]byte
	binary.LittleEndian.PutUint64(buf[0:8], 0)
	binary.LittleEndian.PutUint64(buf[8:16], 0)
	binary.LittleEndian.PutUint16(buf[16:18], typ)
	binary.LittleEndian.PutUint16(buf[18:20], code)
	binary.LittleEndian.PutUint32(buf[20:24], uint32(value))
	fd := int(d.uinputFd.Fd())
	_, err := syscall.Write(fd, buf[:])
	return err
}

func synSequenceEvent() outputEvent {
	return outputEvent{typ: EV_SYN, code: SYN_REPORT, value: 0}
}

func passthroughSequence(ev InputEvent) []outputEvent {
	return []outputEvent{{typ: ev.Type, code: ev.Code, value: ev.Value}}
}

func keyTapSequence(code uint16) []outputEvent {
	return []outputEvent{
		{typ: EV_KEY, code: code, value: keyPress},
		{typ: EV_KEY, code: code, value: keyRelease},
		synSequenceEvent(),
	}
}

func mappedKeyTapSequence(key mappedKey) []outputEvent {
	seq := make([]outputEvent, 0, 5)
	if key.shifted {
		seq = append(seq, outputEvent{typ: EV_KEY, code: KEY_LEFTSHIFT, value: keyPress})
	}
	seq = append(seq,
		outputEvent{typ: EV_KEY, code: key.code, value: keyPress},
		outputEvent{typ: EV_KEY, code: key.code, value: keyRelease},
	)
	if key.shifted {
		seq = append(seq, outputEvent{typ: EV_KEY, code: KEY_LEFTSHIFT, value: keyRelease})
	}
	seq = append(seq, synSequenceEvent())
	return seq
}

func mappedReplaceSequence(key mappedKey) []outputEvent {
	seq := make([]outputEvent, 0, 7)
	seq = append(seq,
		outputEvent{typ: EV_KEY, code: KEY_BACKSPACE, value: keyPress},
		outputEvent{typ: EV_KEY, code: KEY_BACKSPACE, value: keyRelease},
	)
	if key.shifted {
		seq = append(seq, outputEvent{typ: EV_KEY, code: KEY_LEFTSHIFT, value: keyPress})
	}
	seq = append(seq,
		outputEvent{typ: EV_KEY, code: key.code, value: keyPress},
		outputEvent{typ: EV_KEY, code: key.code, value: keyRelease},
	)
	if key.shifted {
		seq = append(seq, outputEvent{typ: EV_KEY, code: KEY_LEFTSHIFT, value: keyRelease})
	}
	seq = append(seq, synSequenceEvent())
	return seq
}

func passthroughWithShiftSequence(ev InputEvent, korean bool) []outputEvent {
	if korean {
		if ev.Value == keyPress {
			return []outputEvent{
				{typ: EV_KEY, code: KEY_LEFTSHIFT, value: keyPress},
				{typ: EV_KEY, code: ev.Code, value: keyPress},
				{typ: EV_KEY, code: ev.Code, value: keyRelease},
				{typ: EV_KEY, code: KEY_LEFTSHIFT, value: keyRelease},
				synSequenceEvent(),
			}
		}
		if ev.Value == keyRelease {
			return nil
		}
	}

	if ev.Value == keyPress {
		return []outputEvent{
			{typ: EV_KEY, code: KEY_LEFTSHIFT, value: keyPress},
			{typ: EV_KEY, code: ev.Code, value: keyPress},
			synSequenceEvent(),
		}
	}
	if ev.Value == keyRelease {
		return []outputEvent{
			{typ: EV_KEY, code: ev.Code, value: keyRelease},
			{typ: EV_KEY, code: KEY_LEFTSHIFT, value: keyRelease},
			synSequenceEvent(),
		}
	}
	return passthroughSequence(ev)
}

func (d *Daemon) emitSequence(seq []outputEvent) error {
	for _, ev := range seq {
		if err := d.writeEvent(ev.typ, ev.code, ev.value); err != nil {
			return err
		}
	}
	return nil
}

func (d *Daemon) sendKey(code uint16, press bool) error {
	val := int32(keyRelease)
	if press {
		val = keyPress
	}
	return d.enqueueOutputJob(outputJob{
		kind:     outputJobEmitSequence,
		sequence: []outputEvent{{typ: EV_KEY, code: code, value: val}, synSequenceEvent()},
	})
}

func (d *Daemon) sendKeyTap(code uint16) error {
	return d.enqueueOutputJob(outputJob{kind: outputJobEmitSequence, sequence: keyTapSequence(code)})
}

func (d *Daemon) sendMappedKeyTap(key mappedKey) error {
	return d.enqueueOutputJob(outputJob{kind: outputJobEmitSequence, sequence: mappedKeyTapSequence(key)})
}

func (d *Daemon) sendMappedReplace(key mappedKey) error {
	return d.enqueueOutputJob(outputJob{kind: outputJobEmitSequence, sequence: mappedReplaceSequence(key)})
}

func (d *Daemon) sendBackspace() error {
	return d.sendKeyTap(KEY_BACKSPACE)
}

func cloneOutputLayout(slots []outputSlot) []outputSlot {
	if len(slots) == 0 {
		return nil
	}
	cloned := make([]outputSlot, len(slots))
	copy(cloned, slots)
	return cloned
}

func (d *Daemon) applyOutputLayoutSnapshot(layout []outputSlot) error {
	for _, slot := range layout {
		if slot.char != 0 {
			if err := d.patcher.writeKeyEntryToDisk(slot.spec.code, slot.spec.mod, uint16(slot.char), uint32(slot.char)); err != nil {
				return err
			}
			continue
		}
		if err := d.patcher.restoreKeyEntry(slot.spec.code, slot.spec.mod); err != nil {
			return err
		}
	}
	return nil
}

func (d *Daemon) enqueueOutputJob(job outputJob) error {
	if d.outputCh == nil {
		return fmt.Errorf("output worker not initialized")
	}
	select {
	case <-d.outputStopCh:
		return fmt.Errorf("output worker stopped")
	default:
	}
	d.outputCh <- job
	return nil
}

func (d *Daemon) enqueueOutputResult(result outputResult) {
	if d.outputResultCh == nil {
		return
	}
	if len(result.releaseSlots) == 0 && !result.previewShown {
		return
	}
	d.outputResultCh <- result
}

func (d *Daemon) applyOutputResultLocked(result outputResult) {
	for _, slotIndex := range result.releaseSlots {
		if slotIndex < 0 || slotIndex >= len(d.outputSlots) {
			continue
		}
		slot := &d.outputSlots[slotIndex]
		if slot.state != outputSlotReservedCommit {
			continue
		}
		if slot.char == 0 {
			slot.state = outputSlotFree
			continue
		}
		slot.state = outputSlotResident
	}
	if result.previewShown {
		if result.generation == d.composeGeneration {
			if char, ok := d.currentPendingChar(); ok && char == result.char {
				d.pendingVisible = true
				d.visibleChar = result.char
				d.previewPending = false
				d.previewChar = 0
			}
		}
	}
}

func (d *Daemon) startOutputWorker() {
	if d.outputCh == nil || d.outputStopCh == nil {
		return
	}
	d.outputWg.Add(1)
	go func() {
		defer d.outputWg.Done()
		for {
			select {
			case <-d.outputStopCh:
				return
			case job := <-d.outputCh:
				batch := d.drainOutputBatch(job)
				if err := d.runOutputBatch(batch); err != nil {
					log.Printf("[OUTPUT] worker job failed: %v", err)
				}
			}
		}
	}()
}

func (d *Daemon) stopOutputWorkerLocked() {
	if d.outputStopCh == nil {
		return
	}
	close(d.outputStopCh)
	d.outputStopCh = nil
	d.outputWg.Wait()
	d.outputCh = nil
}

func (d *Daemon) drainOutputBatch(first outputJob) []outputJob {
	batch := []outputJob{first}
	for len(batch) < maxOutputBatchJobs {
		select {
		case job := <-d.outputCh:
			batch = append(batch, job)
		default:
			return batch
		}
	}
	return batch
}

func outputJobIsRender(kind outputJobKind) bool {
	return kind == outputJobPreviewRender || kind == outputJobCommitRender
}

func dropReplaceBackspace(seq []outputEvent) []outputEvent {
	if len(seq) < 3 {
		return seq
	}
	if seq[0].typ != EV_KEY || seq[0].code != KEY_BACKSPACE || seq[0].value != keyPress {
		return seq
	}
	if seq[1].typ != EV_KEY || seq[1].code != KEY_BACKSPACE || seq[1].value != keyRelease {
		return seq
	}
	if seq[2].typ != EV_SYN || seq[2].code != SYN_REPORT {
		return seq
	}
	trimmed := make([]outputEvent, len(seq)-3)
	copy(trimmed, seq[3:])
	return trimmed
}

func (d *Daemon) runSyncLayoutJob(job outputJob) error {
	if err := d.applyOutputLayoutSnapshot(job.layout); err != nil {
		return fmt.Errorf("sync output layout: %w", err)
	}
	if err := d.recreateUinput(); err != nil {
		return fmt.Errorf("sync output layout recreate: %w", err)
	}
	return nil
}

func (d *Daemon) runRestoreLayoutJob(job outputJob) error {
	for _, slot := range job.layout {
		if err := d.patcher.restoreKeyEntry(slot.spec.code, slot.spec.mod); err != nil {
			return fmt.Errorf("restore output layout: %w", err)
		}
	}
	if d.uinputFd != nil {
		if err := d.recreateUinput(); err != nil {
			return fmt.Errorf("restore output layout recreate: %w", err)
		}
	}
	return nil
}

func trimDroppedPreviewRender(job outputJob, droppedPreview bool) outputJob {
	if droppedPreview && !job.visibleAtEnqueue {
		job.sequence = dropReplaceBackspace(job.sequence)
	}
	return job
}

func (d *Daemon) ensureRenderScratch() {
	slotCount := len(d.outputSlots)
	if len(d.renderLatestJobs) != slotCount {
		d.renderLatestJobs = make([]outputJob, slotCount)
		d.renderLatestSet = make([]bool, slotCount)
		d.renderDroppedPreview = make([]bool, slotCount)
		d.renderReleaseSet = make([]bool, slotCount)
	}
	d.renderOrder = d.renderOrder[:0]
	d.renderFiltered = d.renderFiltered[:0]
	d.renderTouchedDropped = d.renderTouchedDropped[:0]
	d.renderReleaseSlots = d.renderReleaseSlots[:0]
}

func (d *Daemon) resetRenderScratch() {
	for _, slotIndex := range d.renderOrder {
		d.renderLatestSet[slotIndex] = false
	}
	for _, slotIndex := range d.renderTouchedDropped {
		d.renderDroppedPreview[slotIndex] = false
	}
	for _, slotIndex := range d.renderReleaseSlots {
		d.renderReleaseSet[slotIndex] = false
	}
	d.renderOrder = d.renderOrder[:0]
	d.renderFiltered = d.renderFiltered[:0]
	d.renderTouchedDropped = d.renderTouchedDropped[:0]
	d.renderReleaseSlots = d.renderReleaseSlots[:0]
}

func (d *Daemon) executeSingleRenderJob(job outputJob) error {
	if job.needsPatch {
		if err := d.patcher.writeKeyEntryToDisk(job.spec.code, job.spec.mod, uint16(job.char), uint32(job.char)); err != nil {
			return fmt.Errorf("patch slot %s shift=%t for %q: %w", keyCodeName(job.spec.code), job.spec.mod != 0, job.char, err)
		}
		if err := d.recreateUinput(); err != nil {
			return fmt.Errorf("render batch recreate: %w", err)
		}
	}
	if len(job.sequence) > 0 {
		if err := d.emitSequence(job.sequence); err != nil {
			return fmt.Errorf("emit render sequence: %w", err)
		}
	}

	result := outputResult{}
	if job.kind == outputJobPreviewRender {
		result.previewShown = true
		result.char = job.char
		result.generation = job.generation
	}
	if job.releaseSlot {
		result.releaseSlots = []int{job.slotIndex}
	}
	d.enqueueOutputResult(result)
	return nil
}

func (d *Daemon) executeFilteredRenderJobs(filtered []outputJob) error {
	if len(filtered) == 0 {
		return nil
	}
	if len(filtered) == 1 {
		return d.executeSingleRenderJob(filtered[0])
	}

	needsRecreate := false
	for _, job := range filtered {
		if !job.needsPatch {
			continue
		}
		if err := d.patcher.writeKeyEntryToDisk(job.spec.code, job.spec.mod, uint16(job.char), uint32(job.char)); err != nil {
			return fmt.Errorf("patch slot %s shift=%t for %q: %w", keyCodeName(job.spec.code), job.spec.mod != 0, job.char, err)
		}
		needsRecreate = true
	}
	if needsRecreate {
		if err := d.recreateUinput(); err != nil {
			return fmt.Errorf("render batch recreate: %w", err)
		}
	}

	releaseSlots := d.renderReleaseSlots[:0]
	for _, job := range filtered {
		if len(job.sequence) > 0 {
			if err := d.emitSequence(job.sequence); err != nil {
				return fmt.Errorf("emit render sequence: %w", err)
			}
		}
		if job.kind == outputJobPreviewRender {
			d.enqueueOutputResult(outputResult{
				previewShown: true,
				char:         job.char,
				generation:   job.generation,
			})
		}
		if job.releaseSlot {
			if job.slotIndex >= 0 && job.slotIndex < len(d.renderReleaseSet) && !d.renderReleaseSet[job.slotIndex] {
				d.renderReleaseSet[job.slotIndex] = true
				releaseSlots = append(releaseSlots, job.slotIndex)
			}
		}
	}
	d.renderReleaseSlots = releaseSlots
	if len(releaseSlots) > 0 {
		releaseCopy := append([]int(nil), releaseSlots...)
		d.enqueueOutputResult(outputResult{releaseSlots: releaseCopy})
	}
	return nil
}

func (d *Daemon) runRenderBatch(jobs []outputJob, meta renderBatchMeta) error {
	if meta.jobCount == 0 {
		return nil
	}
	if meta.jobCount == 1 {
		return d.executeSingleRenderJob(jobs[0])
	}

	d.ensureRenderScratch()
	defer d.resetRenderScratch()

	filtered := d.renderFiltered
	if meta.hasCommit {
		for _, job := range jobs {
			slotIndex := job.slotIndex
			if job.kind == outputJobPreviewRender {
				if slotIndex >= 0 && slotIndex < len(d.renderDroppedPreview) && !d.renderDroppedPreview[slotIndex] {
					d.renderDroppedPreview[slotIndex] = true
					d.renderTouchedDropped = append(d.renderTouchedDropped, slotIndex)
				}
				continue
			}
			dropped := slotIndex >= 0 && slotIndex < len(d.renderDroppedPreview) && d.renderDroppedPreview[slotIndex]
			filtered = append(filtered, trimDroppedPreviewRender(job, dropped))
		}
		d.renderFiltered = filtered
		return d.executeFilteredRenderJobs(filtered)
	}

	for _, job := range jobs {
		slotIndex := job.slotIndex
		if slotIndex < 0 || slotIndex >= len(d.renderLatestJobs) {
			filtered = append(filtered, job)
			continue
		}
		if !d.renderLatestSet[slotIndex] {
			d.renderLatestSet[slotIndex] = true
			d.renderOrder = append(d.renderOrder, slotIndex)
		} else if !d.renderDroppedPreview[slotIndex] {
			d.renderDroppedPreview[slotIndex] = true
			d.renderTouchedDropped = append(d.renderTouchedDropped, slotIndex)
		}
		d.renderLatestJobs[slotIndex] = job
	}
	for _, slotIndex := range d.renderOrder {
		filtered = append(filtered, trimDroppedPreviewRender(d.renderLatestJobs[slotIndex], d.renderDroppedPreview[slotIndex]))
	}
	d.renderFiltered = filtered
	return d.executeFilteredRenderJobs(filtered)
}

func (d *Daemon) runOutputBatch(batch []outputJob) error {
	for i := 0; i < len(batch); {
		switch batch[i].kind {
		case outputJobEmitSequence:
			seq := make([]outputEvent, 0)
			for i < len(batch) && batch[i].kind == outputJobEmitSequence {
				seq = append(seq, batch[i].sequence...)
				i++
			}
			if err := d.emitSequence(seq); err != nil {
				return fmt.Errorf("emit batched sequence: %w", err)
			}
		case outputJobPreviewRender, outputJobCommitRender:
			start := i
			meta := renderBatchMeta{}
			for i < len(batch) && outputJobIsRender(batch[i].kind) {
				meta.jobCount++
				if batch[i].kind == outputJobCommitRender {
					meta.hasCommit = true
				}
				i++
			}
			if err := d.runRenderBatch(batch[start:i], meta); err != nil {
				return err
			}
		case outputJobSyncLayout:
			job := batch[i]
			i++
			for i < len(batch) && batch[i].kind == outputJobSyncLayout {
				job = batch[i]
				i++
			}
			if err := d.runSyncLayoutJob(job); err != nil {
				return err
			}
		case outputJobRestoreLayout:
			job := batch[i]
			i++
			for i < len(batch) && batch[i].kind == outputJobRestoreLayout {
				job = batch[i]
				i++
			}
			if err := d.runRestoreLayoutJob(job); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unknown output job kind: %d", batch[i].kind)
		}
	}
	return nil
}

func (d *Daemon) passthrough(ev InputEvent) {
	if err := d.enqueueOutputJob(outputJob{kind: outputJobEmitSequence, sequence: passthroughSequence(ev)}); err != nil {
		log.Printf("[OUTPUT] passthrough enqueue failed: %v", err)
	}
}

func specialPassthroughRune(code uint16, shifted bool) (rune, bool) {
	if code == KEY_6 && shifted {
		return '^', true
	}
	return 0, false
}

func (d *Daemon) passthroughWithShift(ev InputEvent) {
	if !d.shifted || ev.Type != EV_KEY || ev.Value == keyRepeat {
		d.passthrough(ev)
		return
	}
	seq := passthroughWithShiftSequence(ev, d.korean)
	if len(seq) == 0 {
		return
	}
	if err := d.enqueueOutputJob(outputJob{kind: outputJobEmitSequence, sequence: seq}); err != nil {
		log.Printf("[OUTPUT] shifted passthrough enqueue failed: %v", err)
	}
}

func (d *Daemon) signalRescan() {
	if d.rescanCh == nil {
		return
	}
	select {
	case d.rescanCh <- struct{}{}:
	default:
	}
}

func (d *Daemon) initOutputLayout() error {
	specs := d.outputSpecs

	d.outputMap = make(map[rune]mappedKey, len(specs))
	d.outputIndex = make(map[rune]int, len(specs))
	d.outputSlots = make([]outputSlot, len(specs))
	d.clearComposeSlotState()
	for i, spec := range specs {
		d.outputSlots[i] = outputSlot{spec: spec, state: outputSlotFree}
	}
	return nil
}

func (d *Daemon) initOutputSpecs() error {
	candidates := allOutputSlotSpecs()
	d.outputSpecs = make([]keyPatchSpec, 0, len(candidates))
	for _, spec := range candidates {
		if err := d.patcher.initKeyEntry(spec); err != nil {
			log.Printf("[OUTPUT] unsupported slot skipped: %s shift=%t unicode=U+%04X (%v)", keyCodeName(spec.code), spec.mod != 0, spec.unicode, err)
			continue
		}
		d.outputSpecs = append(d.outputSpecs, spec)
	}
	if len(d.outputSpecs) == 0 {
		return fmt.Errorf("no supported output slot specs found")
	}
	return d.patcher.openMappedFile()
}

func (d *Daemon) applyOutputLayoutToDisk() error {
	return d.applyOutputLayoutSnapshot(d.outputSlots)
}

func (d *Daemon) activateOutputLayout() error {
	if d.layoutActive {
		return nil
	}
	snapshot := cloneOutputLayout(d.outputSlots)
	if err := d.enqueueOutputJob(outputJob{kind: outputJobSyncLayout, layout: snapshot}); err != nil {
		return fmt.Errorf("queue output layout sync: %w", err)
	}
	d.layoutActive = true
	return nil
}

func (d *Daemon) restoreOutputLayout() error {
	if d.patcher == nil {
		return nil
	}
	if !d.layoutActive {
		return nil
	}
	d.clearComposeSlotState()
	if err := d.enqueueOutputJob(outputJob{kind: outputJobRestoreLayout, layout: cloneOutputLayout(d.outputSlots)}); err != nil {
		return fmt.Errorf("queue output layout restore: %w", err)
	}
	d.layoutActive = false
	return nil
}

func (d *Daemon) reinitializeOutputLayoutForCurrentMode() error {
	if d.patcher == nil {
		return nil
	}
	d.clearComposeSlotState()
	for _, slot := range d.outputSlots {
		if err := d.patcher.restoreKeyEntry(slot.spec.code, slot.spec.mod); err != nil {
			return fmt.Errorf("restore output layout: %w", err)
		}
	}
	d.layoutActive = false
	if d.korean {
		if err := d.applyOutputLayoutToDisk(); err != nil {
			return fmt.Errorf("reapply output layout: %w", err)
		}
		d.layoutActive = true
	}
	if d.uinputFd != nil {
		if err := d.recreateUinput(); err != nil {
			return fmt.Errorf("recreate uinput after layout reinit: %w", err)
		}
	}
	return nil
}

func (d *Daemon) lookupOutputChar(char rune) (mappedKey, bool) {
	idx, ok := d.outputIndex[char]
	if !ok || idx < 0 || idx >= len(d.outputSlots) {
		return mappedKey{}, false
	}
	slot := &d.outputSlots[idx]
	if slot.state != outputSlotResident {
		return mappedKey{}, false
	}
	d.lruUseTick++
	slot.lastUsed = d.lruUseTick
	return mappedKeyFromSpec(slot.spec), true
}

func (d *Daemon) clearComposeSlotState() {
	if d.composeSlotActive && d.composeSlotIndex >= 0 && d.composeSlotIndex < len(d.outputSlots) {
		slot := &d.outputSlots[d.composeSlotIndex]
		if slot.state == outputSlotPreviewVisible {
			if slot.char == 0 {
				slot.state = outputSlotFree
			} else {
				slot.state = outputSlotResident
			}
		}
	}
	d.composeSlotActive = false
	d.composeSlotIndex = -1
}

func (d *Daemon) selectOutputSlotIndex() (int, error) {
	for i := range d.outputSlots {
		if d.outputSlots[i].state == outputSlotFree {
			return i, nil
		}
	}
	slotIndex := -1
	var minUsed uint64 = ^uint64(0)
	for i := range d.outputSlots {
		slot := d.outputSlots[i]
		if slot.state != outputSlotResident {
			continue
		}
		if slot.lastUsed < minUsed {
			minUsed = slot.lastUsed
			slotIndex = i
		}
	}
	if slotIndex >= 0 {
		return slotIndex, nil
	}
	return -1, fmt.Errorf("no output slot available")
}

func (d *Daemon) bindOutputSlot(slotIndex int, char rune, state outputSlotState) (mappedKey, outputSlotSnapshot, bool) {
	slot := &d.outputSlots[slotIndex]
	snapshot := outputSlotSnapshot{
		prevChar:     slot.char,
		prevLastUsed: slot.lastUsed,
		prevTick:     d.lruUseTick,
		prevState:    slot.state,
	}
	newTick := snapshot.prevTick + 1
	key := mappedKeyFromSpec(slot.spec)

	if snapshot.prevChar != 0 {
		delete(d.outputMap, snapshot.prevChar)
		delete(d.outputIndex, snapshot.prevChar)
	}
	slot.char = char
	slot.state = state
	slot.lastUsed = newTick
	d.lruUseTick = newTick
	d.outputMap[char] = key
	d.outputIndex[char] = slotIndex
	return key, snapshot, snapshot.prevChar != char
}

func (d *Daemon) rollbackBoundOutputSlot(slotIndex int, snapshot outputSlotSnapshot, char rune) {
	slot := &d.outputSlots[slotIndex]
	delete(d.outputMap, char)
	delete(d.outputIndex, char)
	slot.char = snapshot.prevChar
	slot.lastUsed = snapshot.prevLastUsed
	slot.state = snapshot.prevState
	d.lruUseTick = snapshot.prevTick
	if snapshot.prevChar != 0 {
		key := mappedKeyFromSpec(slot.spec)
		d.outputMap[snapshot.prevChar] = key
		d.outputIndex[snapshot.prevChar] = slotIndex
	}
}

func (d *Daemon) ensurePreviewSlot(char rune) (outputSlotBinding, error) {
	if d.composeSlotActive && d.composeSlotIndex >= 0 && d.composeSlotIndex < len(d.outputSlots) {
		slotIndex := d.composeSlotIndex
		if d.outputSlots[slotIndex].state == outputSlotPreviewVisible {
			key, snapshot, patchNeeded := d.bindOutputSlot(slotIndex, char, outputSlotPreviewVisible)
			return outputSlotBinding{
				slotIndex:   slotIndex,
				key:         key,
				snapshot:    snapshot,
				patchNeeded: patchNeeded,
			}, nil
		}
	}

	if idx, ok := d.outputIndex[char]; ok && idx >= 0 && idx < len(d.outputSlots) {
		if d.outputSlots[idx].state == outputSlotResident {
			key, snapshot, patchNeeded := d.bindOutputSlot(idx, char, outputSlotPreviewVisible)
			d.composeSlotActive = true
			d.composeSlotIndex = idx
			return outputSlotBinding{
				slotIndex:   idx,
				key:         key,
				snapshot:    snapshot,
				patchNeeded: patchNeeded,
			}, nil
		}
	}

	slotIndex, err := d.selectOutputSlotIndex()
	if err != nil {
		return outputSlotBinding{}, fmt.Errorf("no compose slot available for %q: %w", char, err)
	}
	key, snapshot, patchNeeded := d.bindOutputSlot(slotIndex, char, outputSlotPreviewVisible)
	d.composeSlotActive = true
	d.composeSlotIndex = slotIndex
	return outputSlotBinding{
		slotIndex:   slotIndex,
		key:         key,
		snapshot:    snapshot,
		patchNeeded: patchNeeded,
	}, nil
}

func (d *Daemon) reserveCommitSlot(char rune, preferCompose bool) (outputSlotBinding, error) {
	if preferCompose && d.composeSlotActive && d.composeSlotIndex >= 0 && d.composeSlotIndex < len(d.outputSlots) {
		slotIndex := d.composeSlotIndex
		if d.outputSlots[slotIndex].state == outputSlotPreviewVisible {
			key, snapshot, patchNeeded := d.bindOutputSlot(slotIndex, char, outputSlotReservedCommit)
			return outputSlotBinding{
				slotIndex:   slotIndex,
				key:         key,
				snapshot:    snapshot,
				patchNeeded: patchNeeded,
			}, nil
		}
	}

	if idx, ok := d.outputIndex[char]; ok && idx >= 0 && idx < len(d.outputSlots) {
		if d.outputSlots[idx].state == outputSlotResident {
			key, snapshot, patchNeeded := d.bindOutputSlot(idx, char, outputSlotReservedCommit)
			return outputSlotBinding{
				slotIndex:   idx,
				key:         key,
				snapshot:    snapshot,
				patchNeeded: patchNeeded,
			}, nil
		}
	}

	slotIndex, err := d.selectOutputSlotIndex()
	if err != nil {
		return outputSlotBinding{}, fmt.Errorf("no output slot available for %q: %w", char, err)
	}
	key, snapshot, patchNeeded := d.bindOutputSlot(slotIndex, char, outputSlotReservedCommit)
	return outputSlotBinding{
		slotIndex:   slotIndex,
		key:         key,
		snapshot:    snapshot,
		patchNeeded: patchNeeded,
	}, nil
}

func buildMappedOutputSequence(key mappedKey, backspaces int, batchReplace bool) []outputEvent {
	if batchReplace && backspaces == 1 {
		return mappedReplaceSequence(key)
	}
	seq := make([]outputEvent, 0, backspaces*len(keyTapSequence(KEY_BACKSPACE))+len(mappedKeyTapSequence(key)))
	for i := 0; i < backspaces; i++ {
		seq = append(seq, keyTapSequence(KEY_BACKSPACE)...)
	}
	seq = append(seq, mappedKeyTapSequence(key)...)
	return seq
}

func (d *Daemon) enqueueRenderJob(kind outputJobKind, binding outputSlotBinding, char rune, sequence []outputEvent, generation uint64, visibleAtEnqueue bool, needsPatch bool, releaseSlot bool) error {
	slot := d.outputSlots[binding.slotIndex]
	return d.enqueueOutputJob(outputJob{
		kind:        kind,
		slotIndex:   binding.slotIndex,
		spec:        slot.spec,
		char:        char,
		generation:  generation,
		visibleAtEnqueue: visibleAtEnqueue,
		sequence:    sequence,
		needsPatch:  needsPatch,
		releaseSlot: releaseSlot,
	})
}

func (d *Daemon) outputComposeChar(char rune, backspaces int, batchReplace bool, commit bool) error {
	if d.patcher == nil {
		return fmt.Errorf("patcher not initialized")
	}

	layoutWasActive := d.layoutActive
	var (
		binding outputSlotBinding
		err     error
	)
	if commit {
		binding, err = d.reserveCommitSlot(char, true)
	} else {
		binding, err = d.ensurePreviewSlot(char)
	}
	if err != nil {
		return fmt.Errorf("assign compose slot: %w", err)
	}
	if err := d.activateOutputLayout(); err != nil {
		d.rollbackBoundOutputSlot(binding.slotIndex, binding.snapshot, char)
		if !commit && binding.snapshot.prevState != outputSlotPreviewVisible {
			d.clearComposeSlotState()
		}
		return fmt.Errorf("activate output layout: %w", err)
	}
	jobKind := outputJobPreviewRender
	if commit {
		jobKind = outputJobCommitRender
	}
	if err := d.enqueueRenderJob(jobKind, binding, char, buildMappedOutputSequence(binding.key, backspaces, batchReplace), d.composeGeneration, d.pendingVisible, binding.patchNeeded && layoutWasActive, commit); err != nil {
		d.rollbackBoundOutputSlot(binding.slotIndex, binding.snapshot, char)
		if !commit && binding.snapshot.prevState != outputSlotPreviewVisible {
			d.clearComposeSlotState()
		}
		return fmt.Errorf("queue compose render for %q: %w", char, err)
	}
	return nil
}

// outputChar: 일반 출력 캐시(LRU)를 사용해 문자를 전달
func (d *Daemon) outputChar(char rune, backspaces int, batchReplace bool) error {
	if d.patcher == nil {
		return fmt.Errorf("patcher not initialized")
	}

	layoutWasActive := d.layoutActive
	binding, err := d.reserveCommitSlot(char, false)
	if err != nil {
		return fmt.Errorf("assign output slot: %w", err)
	}
	if err := d.activateOutputLayout(); err != nil {
		d.rollbackBoundOutputSlot(binding.slotIndex, binding.snapshot, char)
		return fmt.Errorf("activate output layout: %w", err)
	}
	if err := d.enqueueRenderJob(outputJobCommitRender, binding, char, buildMappedOutputSequence(binding.key, backspaces, batchReplace), d.composeGeneration, d.pendingVisible, binding.patchNeeded && layoutWasActive, true); err != nil {
		d.rollbackBoundOutputSlot(binding.slotIndex, binding.snapshot, char)
		return fmt.Errorf("queue output render for %q: %w", char, err)
	}
	return nil
}

// restoreKeymap: 영문 모드/단축키 모드 전환 시 원본 키맵 복원
func (d *Daemon) restoreKeymap() {
	if err := d.restoreOutputLayout(); err != nil {
		log.Printf("[RESTORE] 원본 키맵 복원 오류: %v", err)
		return
	}
	log.Printf("[RESTORE] 원본 키맵 복원 완료")
}

func (d *Daemon) toggleKoreanMode() error {
	if err := d.commitCurrent(); err != nil {
		return err
	}
	d.restoreKeymap()
	d.korean = !d.korean
	if d.korean {
		log.Println("모드: 한글")
	} else {
		log.Println("모드: 영문")
	}
	return nil
}

func stopAndDrainTimer(timer *time.Timer) {
	if timer == nil {
		return
	}
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}

func (d *Daemon) startIdleFlushLoop() {
	if d.idleFlushCmdCh == nil {
		return
	}
	go func(cmdCh <-chan idleFlushCommand) {
		timer := time.NewTimer(time.Hour)
		stopAndDrainTimer(timer)

		var armedSeq uint64
		var armed bool

		for {
			select {
			case cmd, ok := <-cmdCh:
				if !ok {
					stopAndDrainTimer(timer)
					return
				}
				if cmd.cancel {
					armed = false
					armedSeq = 0
					stopAndDrainTimer(timer)
					continue
				}
				armed = true
				armedSeq = cmd.seq
				stopAndDrainTimer(timer)
				timer.Reset(cmd.delay)
			case <-timer.C:
				if !armed {
					continue
				}
				armed = false
				d.mu.Lock()
				if atomic.LoadUint64(&d.idleFlushSeq) == armedSeq && d.hangul.state != stateEmpty {
					if err := d.showPending(); err != nil {
						log.Printf("[OUTPUT] idle flush failed: %v", err)
					}
				}
				d.mu.Unlock()
			}
		}
	}(d.idleFlushCmdCh)
}

func (d *Daemon) sendIdleFlushCommand(cmd idleFlushCommand) {
	if d.idleFlushCmdCh == nil {
		return
	}
	select {
	case d.idleFlushCmdCh <- cmd:
	default:
		select {
		case <-d.idleFlushCmdCh:
		default:
		}
		d.idleFlushCmdCh <- cmd
	}
}

func (d *Daemon) cancelIdleFlush() {
	atomic.AddUint64(&d.idleFlushSeq, 1)
	d.sendIdleFlushCommand(idleFlushCommand{cancel: true})
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

func (d *Daemon) showPending() error {
	char, ok := d.currentPendingChar()
	if !ok {
		return nil
	}
	if d.previewPending && d.previewChar == char {
		return nil
	}
	if d.pendingMiss && d.pendingMissChar == char {
		return d.flushMissChar(char)
	}
	if d.pendingVisible && d.visibleChar == char {
		return nil
	}
	return d.commitPendingChar(char)
}

func (d *Daemon) maybePreviewCurrent() {
	char, ok := d.currentPendingChar()
	if !ok {
		return
	}
	if d.previewPending && d.previewChar == char {
		d.pendingMiss = false
		d.pendingMissChar = 0
		return
	}
	if d.pendingVisible && d.visibleChar == char {
		d.pendingMiss = false
		d.pendingMissChar = 0
		return
	}
	d.pendingMiss = true
	d.pendingMissChar = char
	d.scheduleIdleFlush()
}

func (d *Daemon) scheduleIdleFlush() {
	if d.hangul.state == stateEmpty {
		return
	}
	seq := atomic.AddUint64(&d.idleFlushSeq, 1)
	d.sendIdleFlushCommand(idleFlushCommand{
		seq:   seq,
		delay: d.currentIdleFlushDelay(),
	})
}

func (d *Daemon) resetCompose() {
	d.cancelIdleFlush()
	d.hangul = HangulState{}
	d.pendingVisible = false
	d.visibleChar = 0
	d.previewPending = false
	d.previewChar = 0
	d.pendingMiss = false
	d.pendingMissChar = 0
	d.composeGeneration++
	d.clearComposeSlotState()
}

func (d *Daemon) commitPendingChar(char rune) error {
	backspaces := 0
	if d.pendingVisible || d.previewPending {
		backspaces = 1
	}
	if err := d.outputComposeChar(char, backspaces, true, false); err != nil {
		return err
	}
	d.previewPending = true
	d.previewChar = char
	d.pendingMiss = false
	d.pendingMissChar = 0
	return nil
}

func (d *Daemon) flushMissChar(char rune) error {
	return d.commitPendingChar(char)
}

func (d *Daemon) renderBackspaceStep(char rune) error {
	backspaces := 0
	if d.pendingVisible || d.previewPending {
		backspaces = 1
	}
	if err := d.outputComposeChar(char, backspaces, false, false); err != nil {
		return err
	}
	d.previewPending = true
	d.previewChar = char
	return nil
}

func (d *Daemon) commitCurrent() error {
	if char, ok := d.currentPendingChar(); ok {
		backspaces := 0
		if d.pendingVisible || d.previewPending {
			backspaces = 1
		}
		if err := d.outputComposeChar(char, backspaces, true, true); err != nil {
			return err
		}
	}
	d.resetCompose()
	return nil
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
		if err := d.commitCurrent(); err != nil {
			log.Printf("[OUTPUT] commit current failed: %v", err)
			return
		}
		if err := d.sendKeyTap(keyCode); err != nil {
			log.Printf("[OUTPUT] passthrough key tap failed: %v", err)
		}
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
			if err := d.outputChar(jungseongToJamo[jungIdx], 0, false); err != nil {
				log.Printf("[OUTPUT] direct jungseong output failed: %v", err)
				return
			}
			d.resetCompose()
		}

	case stateChoseong:
		if isJungseong {
			d.hangul.jung = jungIdx
			d.hangul.state = stateJungseong
			d.maybePreviewCurrent()
		} else if isChoseong {
			if err := d.commitCurrent(); err != nil {
				log.Printf("[OUTPUT] commit current failed: %v", err)
				return
			}
			d.hangul.cho = choIdx
			d.hangul.state = stateChoseong
			d.pendingVisible = false
			d.maybePreviewCurrent()
		}

	case stateJungseong:
		if isChoseong && jongIdx >= 0 {
			d.hangul.jong = jongIdx
			d.hangul.state = stateJongseong
			d.maybePreviewCurrent()
		} else if isJungseong {
			compoundJung := getCompoundJungseong(d.hangul.jung, jungIdx)
			if compoundJung >= 0 {
				d.hangul.jung = compoundJung
				d.maybePreviewCurrent()
			} else {
				if err := d.commitCurrent(); err != nil {
					log.Printf("[OUTPUT] commit current failed: %v", err)
					return
				}
				if err := d.outputChar(jungseongToJamo[jungIdx], 0, false); err != nil {
					log.Printf("[OUTPUT] direct jungseong output failed: %v", err)
					return
				}
				d.resetCompose()
			}
		} else if isChoseong {
			if err := d.commitCurrent(); err != nil {
				log.Printf("[OUTPUT] commit current failed: %v", err)
				return
			}
			d.hangul.cho = choIdx
			d.hangul.state = stateChoseong
			d.pendingVisible = false
			d.maybePreviewCurrent()
		}

	case stateJongseong:
		if isJungseong {
			if split := splitCompoundJongseong(d.hangul.jong); split.ok {
				newCho := int(jongseongToChoseong[split.second])
				d.hangul.jong = int(split.first)
				if err := d.commitCurrent(); err != nil {
					log.Printf("[OUTPUT] commit current failed: %v", err)
					return
				}
				d.hangul.cho = newCho
				d.hangul.jung = jungIdx
				d.hangul.jong = 0
				d.hangul.state = stateJungseong
				d.pendingVisible = false
				d.maybePreviewCurrent()
			} else {
				newCho := int(jongseongToChoseong[d.hangul.jong])
				d.hangul.jong = 0
				if err := d.commitCurrent(); err != nil {
					log.Printf("[OUTPUT] commit current failed: %v", err)
					return
				}
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
				d.maybePreviewCurrent()
			} else {
				if err := d.commitCurrent(); err != nil {
					log.Printf("[OUTPUT] commit current failed: %v", err)
					return
				}
				d.hangul.cho = choIdx
				d.hangul.state = stateChoseong
				d.pendingVisible = false
				d.maybePreviewCurrent()
			}
		} else if isChoseong {
			if err := d.commitCurrent(); err != nil {
				log.Printf("[OUTPUT] commit current failed: %v", err)
				return
			}
			d.hangul.cho = choIdx
			d.hangul.state = stateChoseong
			d.pendingVisible = false
			d.maybePreviewCurrent()
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
		if err := d.renderBackspaceStep(composeSyllable(d.hangul.cho, d.hangul.jung, d.hangul.jong)); err != nil {
			log.Printf("[OUTPUT] render backspace step failed: %v", err)
		}
	case stateJungseong:
		if split := splitCompoundJungseong(d.hangul.jung); split.ok {
			d.hangul.jung = int(split.first)
			if err := d.renderBackspaceStep(composeSyllable(d.hangul.cho, d.hangul.jung, 0)); err != nil {
				log.Printf("[OUTPUT] render backspace step failed: %v", err)
			}
		} else {
			d.hangul.jung = 0
			d.hangul.state = stateChoseong
			if err := d.renderBackspaceStep(choseongToJamo[d.hangul.cho]); err != nil {
				log.Printf("[OUTPUT] render backspace step failed: %v", err)
			}
		}
	case stateChoseong:
		if d.pendingVisible {
			if err := d.sendBackspace(); err != nil {
				log.Printf("[OUTPUT] backspace failed: %v", err)
				return
			}
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
		if ev.Value == keyRelease {
			if d.shiftForwarded {
				d.shiftForwarded = false
				d.passthrough(ev)
			}
			return
		}
		if !d.korean || d.ctrl_or_alt {
			d.shiftForwarded = true
			d.passthrough(ev)
			return
		}
		d.shiftForwarded = false
		return
	}
	// Ctrl Alt 상태 체크
	if ev.Code == KEY_LEFTCTRL || ev.Code == KEY_LEFTALT {
		if ev.Value == keyPress {
			d.ctrl_or_alt = true
			if err := d.commitCurrent(); err != nil {
				log.Printf("[OUTPUT] commit current failed: %v", err)
			}
			d.restoreKeymap()
		} else if ev.Value == keyRelease {
			d.ctrl_or_alt = false
		}
		d.passthrough(ev)
		return
	}

	// Right Alt 한영 모드 전환
	if ev.Code == KEY_RIGHTALT {
		if ev.Value == keyPress {
			if err := d.toggleKoreanMode(); err != nil {
				log.Printf("[OUTPUT] commit current failed: %v", err)
			}
		}
		return
	}

	// Shift+Space 한영 모드 전환
	if ev.Code == KEY_SPACE && d.shifted && !d.ctrl_or_alt {
		switch ev.Value {
		case keyPress:
			d.shiftSpaceTogglePending = true
			if err := d.toggleKoreanMode(); err != nil {
				log.Printf("[OUTPUT] commit current failed: %v", err)
			}
		case keyRelease:
			if d.shiftSpaceTogglePending {
				d.shiftSpaceTogglePending = false
			}
		}
		return
	}

	// 한글 모드에서는 CapsLock이 xochitl의 영문 대소문자 상태를 건드리지 않게 막는다.
	if ev.Code == KEY_CAPSLOCK {
		if d.korean && !d.ctrl_or_alt {
			return
		}
		d.passthrough(ev)
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
		if char, ok := specialPassthroughRune(ev.Code, d.shifted); ok {
			if err := d.commitCurrent(); err != nil {
				log.Printf("[OUTPUT] commit current failed: %v", err)
				return
			}
			if err := d.outputChar(char, 0, false); err != nil {
				log.Printf("[OUTPUT] special passthrough output failed: %v", err)
				return
			}
			d.resetCompose()
			return
		}
		if ev.Code == KEY_SPACE || ev.Code == KEY_ENTER || ev.Code == KEY_TAB {
			if err := d.commitCurrent(); err != nil {
				log.Printf("[OUTPUT] commit current failed: %v", err)
				return
			}
			d.passthroughWithShift(ev)
			return
		}
		if ev.Code == KEY_BACKSPACE {
			if d.hangul.state != stateEmpty {
				d.handleBackspace()
				return
			}
			d.passthroughWithShift(ev)
			return
		}
		if err := d.commitCurrent(); err != nil {
			log.Printf("[OUTPUT] commit current failed: %v", err)
			return
		}
		d.passthroughWithShift(ev)
		return
	}

	if ev.Value == keyRelease && isAlphaKey(ev.Code) {
		return
	}
	if ev.Value == keyRelease {
		if _, ok := specialPassthroughRune(ev.Code, d.shifted); ok {
			return
		}
	}

	d.passthroughWithShift(ev)
}

func readDeviceInfo(devPath string) (DeviceInfo, error) {
	base := devPath
	if idx := strings.LastIndex(base, "/"); idx >= 0 {
		base = base[idx+1:]
	}
	num := strings.TrimPrefix(base, "event")
	nameFile := fmt.Sprintf("/sys/class/input/event%s/device/name", num)
	nameBytes, err := os.ReadFile(nameFile)
	if err != nil {
		return DeviceInfo{}, err
	}
	info := DeviceInfo{
		Path: devPath,
		Name: strings.TrimSpace(string(nameBytes)),
	}
	busTypeBytes, err := os.ReadFile(fmt.Sprintf("/sys/class/input/event%s/device/id/bustype", num))
	if err == nil {
		info.BusType = strings.TrimSpace(string(busTypeBytes))
	}
	return info, nil
}

func isSupportedKeyboardDevice(info DeviceInfo) bool {
	lowerName := strings.ToLower(strings.TrimSpace(info.Name))
	if lowerName == "" {
		return false
	}
	for _, term := range []string{"hangul", "gpio", "pwrkey", "power", "button", "touchscreen", "touch", "stylus", "wacom", "pen", "hall", "sensor", "marker"} {
		if strings.Contains(lowerName, term) {
			return false
		}
	}
	if info.BusType == "0005" {
		return true
	}
	for _, term := range []string{"keyboard", "keys", "keychron", "hhkb", "magic keyboard", "mx keys", "k380", "k780", "type folio", "folio"} {
		if strings.Contains(lowerName, term) {
			return true
		}
	}
	return false
}

func scanKeyboardDevices(preferredPath string, verbose bool) ([]DeviceInfo, error) {
	entries, err := os.ReadDir("/dev/input")
	if err != nil {
		return nil, fmt.Errorf("readdir /dev/input: %w", err)
	}
	devices := make([]DeviceInfo, 0)
	seen := make(map[string]struct{})
	appendDevice := func(info DeviceInfo) {
		if _, ok := seen[info.Path]; ok {
			return
		}
		seen[info.Path] = struct{}{}
		devices = append(devices, info)
	}
	if preferredPath != "" {
		if info, err := readDeviceInfo(preferredPath); err == nil {
			if verbose || debugLogging {
				log.Printf("입력 디바이스 후보(우선): %s = %s", info.Path, info.Name)
			}
			appendDevice(info)
		}
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "event") {
			continue
		}
		devPath := "/dev/input/" + entry.Name()
		info, err := readDeviceInfo(devPath)
		if err != nil {
			continue
		}
		if verbose || debugLogging {
			log.Printf("입력 디바이스 발견: %s = %s", devPath, info.Name)
		}
		if !isSupportedKeyboardDevice(info) {
			continue
		}
		appendDevice(info)
	}
	return devices, nil
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

func (d *Daemon) addInputDeviceLocked(info DeviceInfo) error {
	if _, ok := d.inputs[info.Path]; ok {
		return nil
	}
	f, err := os.OpenFile(info.Path, os.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", info.Path, err)
	}
	if err := ioctl(f.Fd(), EVIOCGRAB, 1); err != nil {
		f.Close()
		return fmt.Errorf("EVIOCGRAB %s: %w", info.Path, err)
	}
	if d.inputs == nil {
		d.inputs = make(map[string]*ManagedInput)
	}
	d.inputs[info.Path] = &ManagedInput{Info: info, File: f}
	log.Printf("입력 장치 grab: %s (%s)", info.Path, info.Name)
	go d.readInputLoop(info.Path, f)
	return nil
}

func (d *Daemon) removeInputDeviceLocked(path string) {
	input, ok := d.inputs[path]
	if !ok {
		return
	}
	delete(d.inputs, path)
	if input.File != nil {
		_ = ioctl(input.File.Fd(), EVIOCGRAB, 0)
		_ = input.File.Close()
	}
	log.Printf("입력 장치 해제: %s (%s)", input.Info.Path, input.Info.Name)
}

func (d *Daemon) closeAllInputsLocked() {
	for path := range d.inputs {
		d.removeInputDeviceLocked(path)
	}
}

func (d *Daemon) readInputLoop(path string, f *os.File) {
	fd := int(f.Fd())
	var buf [inputEventSize]byte
	eventCount := 0
	for {
		n, err := syscall.Read(fd, buf[:])
		if err != nil {
			d.inputCh <- InputMessage{Path: path, Err: fmt.Errorf("read %s: %w", path, err)}
			return
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
			log.Printf("[EVT] %s #%d type=%d code=%d val=%d", path, eventCount, ev.Type, ev.Code, ev.Value)
		}
		d.inputCh <- InputMessage{Path: path, Event: ev}
	}
}

type inputDirWatcher struct {
	fd int
}

func newInputDirWatcher() (*inputDirWatcher, error) {
	fd, err := syscall.InotifyInit()
	if err != nil {
		return nil, err
	}
	mask := uint32(syscall.IN_CREATE | syscall.IN_DELETE | syscall.IN_ATTRIB | syscall.IN_MOVED_TO | syscall.IN_MOVED_FROM)
	if _, err := syscall.InotifyAddWatch(fd, "/dev/input", mask); err != nil {
		_ = syscall.Close(fd)
		return nil, err
	}
	return &inputDirWatcher{fd: fd}, nil
}

func (w *inputDirWatcher) close() {
	if w != nil && w.fd >= 0 {
		_ = syscall.Close(w.fd)
		w.fd = -1
	}
}

func (w *inputDirWatcher) wait() error {
	if w == nil || w.fd < 0 {
		return fmt.Errorf("input watcher not initialized")
	}
	var buf [4096]byte
	for {
		_, err := syscall.Read(w.fd, buf[:])
		if err == nil {
			return nil
		}
		if err == syscall.EINTR {
			continue
		}
		return err
	}
}

func (d *Daemon) watchKeyboardDevices() {
	for {
		watcher, err := newInputDirWatcher()
		if err != nil {
			d.signalRescan()
			time.Sleep(2 * time.Second)
			continue
		}
		err = watcher.wait()
		watcher.close()
		if err != nil && err != syscall.EBADF {
			log.Printf("입력 디렉토리 감시 오류: %v", err)
			time.Sleep(500 * time.Millisecond)
		}
		d.signalRescan()
	}
}

func (d *Daemon) reconcileInputsLocked(devices []DeviceInfo) {
	desired := make(map[string]DeviceInfo, len(devices))
	for _, info := range devices {
		desired[info.Path] = info
	}
	for path := range d.inputs {
		if _, ok := desired[path]; !ok {
			d.removeInputDeviceLocked(path)
		}
	}
	for _, info := range devices {
		if err := d.addInputDeviceLocked(info); err != nil {
			log.Printf("입력 장치 추가 실패: %s (%s): %v", info.Path, info.Name, err)
		}
	}
	if len(d.inputs) == 0 && d.layoutActive {
		if err := d.restoreOutputLayout(); err != nil {
			log.Printf("입력 장치 없음: 출력 레이아웃 복원 실패: %v", err)
		}
	}
}

func (d *Daemon) run(preferredPath string) error {
	// 패처 초기화 (디스크에서 KEY_Q 오프셋 검색)
	d.patcher = &KeymapPatcher{}
	if err := d.patcher.init(); err != nil {
		return fmt.Errorf("patcher init: %w", err)
	}
	if err := d.initOutputSpecs(); err != nil {
		return fmt.Errorf("output entry init: %w", err)
	}
	if err := d.initOutputLayout(); err != nil {
		return fmt.Errorf("output layout init: %w", err)
	}

	// xochitl 실행 확인
	if pid, err := findXochitlPID(); err != nil {
		log.Printf("경고: xochitl 미실행 (%v)", err)
	} else {
		log.Printf("xochitl PID: %d", pid)
	}

	// 초기 uinput 디바이스 생성
	if err := d.setupUinput(); err != nil {
		return fmt.Errorf("setup uinput: %w", err)
	}
	d.korean = true
	if err := d.reinitializeOutputLayoutForCurrentMode(); err != nil {
		return fmt.Errorf("initial output layout reinit: %w", err)
	}
	log.Println("모드: 한글 (Shift+Space 또는 Right Alt로 전환)")
	d.outputCh = make(chan outputJob, 1024)
	d.outputResultCh = make(chan outputResult, 1024)
	d.outputStopCh = make(chan struct{})
	d.idleFlushCmdCh = make(chan idleFlushCommand, 1)
	d.startOutputWorker()
	d.startIdleFlushLoop()
	d.inputCh = make(chan InputMessage, 1024)
	d.rescanCh = make(chan struct{}, 1)
	d.inputs = make(map[string]*ManagedInput)

	go d.watchKeyboardDevices()
	d.signalRescan()

	for {
		select {
		case <-d.rescanCh:
			devices, err := scanKeyboardDevices(preferredPath, false)
			preferredPath = ""
			if err != nil {
				log.Printf("키보드 스캔 실패: %v", err)
				time.Sleep(500 * time.Millisecond)
				d.signalRescan()
				continue
			}
			d.mu.Lock()
			d.reconcileInputsLocked(devices)
			d.mu.Unlock()
		case msg := <-d.inputCh:
			d.mu.Lock()
			if msg.Err != nil {
				if _, ok := d.inputs[msg.Path]; ok {
					log.Printf("입력 장치 오류: %v", msg.Err)
					if err := d.commitCurrent(); err != nil {
						log.Printf("[OUTPUT] commit current failed during input removal: %v", err)
					}
					d.removeInputDeviceLocked(msg.Path)
					if len(d.inputs) == 0 && d.layoutActive {
						if err := d.restoreOutputLayout(); err != nil {
							log.Printf("입력 장치 없음: 출력 레이아웃 복원 실패: %v", err)
						}
					}
				}
				d.mu.Unlock()
				d.signalRescan()
				continue
			}
			if _, ok := d.inputs[msg.Path]; !ok {
				d.mu.Unlock()
				continue
			}
			d.handleEvent(msg.Event)
			d.mu.Unlock()
		case result := <-d.outputResultCh:
			d.mu.Lock()
			d.applyOutputResultLocked(result)
			d.mu.Unlock()
		}
	}
}

func (d *Daemon) cleanup() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cancelIdleFlush()
	d.clearComposeSlotState()
	d.closeAllInputsLocked()
	d.stopOutputWorkerLocked()
	if d.patcher != nil {
		for _, slot := range d.outputSlots {
			_ = d.patcher.restoreKeyEntry(slot.spec.code, slot.spec.mod)
		}
		if err := d.patcher.writeToDisk(d.patcher.origUnicode, d.patcher.origQtcode); err != nil {
			log.Printf("[PATCHER] 디스크 원본 복원 실패: %v", err)
		} else {
			log.Printf("[PATCHER] 디스크 원본 복원 완료")
		}
		d.patcher.close()
	}
	if d.uinputFd != nil {
		_ = ioctl(d.uinputFd.Fd(), UI_DEV_DESTROY, 0)
		d.uinputFd.Close()
	}
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	log.Printf("Hangul Keyboard Daemon v2 시작 (다중 입력 장치 지원)")

	preferredPath := ""
	if len(os.Args) > 1 {
		preferredPath = os.Args[1]
	}

	d := &Daemon{}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("종료 중...")
		d.cleanup()
		os.Exit(0)
	}()

	if err := d.run(preferredPath); err != nil {
		d.cleanup()
		log.Fatal(err)
	}
}
