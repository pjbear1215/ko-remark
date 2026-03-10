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
	KEY_LEFTSHIFT  = 42
	KEY_Z          = 44
	KEY_X          = 45
	KEY_C          = 46
	KEY_V          = 47
	KEY_B          = 48
	KEY_N          = 49
	KEY_M          = 50
	KEY_RIGHTSHIFT = 54
	KEY_LEFTALT    = 56
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

// 키맵 디스크 패칭: libepaper.so의 KEY_Q 엔트리를 직접 수정
// xochitl은 새 evdev 디바이스 감지 시 핸들러를 생성하며,
// 이때 디스크의 키맵 데이터를 읽어 내부 조회 테이블을 구축함
// → 디바이스를 재생성하면 패치된 키맵이 적용됨
type KeymapPatcher struct {
	fileOffsets []int64 // KEY_Q 엔트리의 파일 오프셋 목록
	diskPath    string  // libepaper.so 디스크 경로
	origUnicode uint16
	origQtcode  uint32
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

func (kp *KeymapPatcher) writeToDisk(unicode uint16, qtcode uint32) error {
	f, err := os.OpenFile(kp.diskPath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open %s for write: %w", kp.diskPath, err)
	}
	defer f.Close()

	uniBuf := make([]byte, 2)
	binary.LittleEndian.PutUint16(uniBuf, unicode)
	qtBuf := make([]byte, 4)
	binary.LittleEndian.PutUint32(qtBuf, qtcode)

	for _, fOff := range kp.fileOffsets {
		if _, err := f.WriteAt(uniBuf, fOff+2); err != nil {
			return fmt.Errorf("write unicode at 0x%x: %w", fOff+2, err)
		}
		if _, err := f.WriteAt(qtBuf, fOff+4); err != nil {
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
var choseongMap = map[uint16]int{
	KEY_R: 0, KEY_E: 3, KEY_Q: 7, KEY_T: 9, KEY_D: 11,
	KEY_W: 12, KEY_Z: 15, KEY_X: 16, KEY_C: 14, KEY_V: 17,
	KEY_G: 18, KEY_A: 6, KEY_S: 2, KEY_F: 5,
}

var choseongShiftMap = map[uint16]int{
	KEY_R: 1, KEY_E: 4, KEY_Q: 8, KEY_T: 10, KEY_W: 13,
}

var jungseongMap = map[uint16]int{
	KEY_K: 0, KEY_O: 1, KEY_I: 2, KEY_J: 4, KEY_P: 5,
	KEY_U: 6, KEY_H: 8, KEY_Y: 12, KEY_N: 13, KEY_B: 17,
	KEY_M: 18, KEY_L: 20,
}

var jungseongShiftMap = map[uint16]int{
	KEY_O: 3, KEY_P: 7,
}

var jongseongMap = map[uint16]int{
	KEY_R: 1, KEY_S: 4, KEY_E: 7, KEY_F: 8, KEY_A: 16,
	KEY_Q: 17, KEY_T: 19, KEY_D: 21, KEY_W: 22, KEY_C: 23,
	KEY_Z: 24, KEY_X: 25, KEY_V: 26, KEY_G: 27,
}

var jongseongShiftMap = map[uint16]int{
	KEY_T: 20,
}

var jongseongToChoseong = map[int]int{
	1: 0, 4: 2, 7: 3, 8: 5, 16: 6, 17: 7,
	19: 9, 20: 10, 21: 11, 22: 12, 23: 14,
	24: 15, 25: 16, 26: 17, 27: 18,
}

var compoundJongseong = map[[2]int]int{
	{1, 19}: 3, {4, 22}: 5, {4, 27}: 6,
	{8, 1}: 9, {8, 16}: 10, {8, 17}: 11,
	{8, 19}: 12, {8, 25}: 13, {8, 26}: 14,
	{8, 27}: 15, {17, 19}: 18,
}

var compoundJongseongSplit = map[int][2]int{
	3: {1, 19}, 5: {4, 22}, 6: {4, 27},
	9: {8, 1}, 10: {8, 16}, 11: {8, 17},
	12: {8, 19}, 13: {8, 25}, 14: {8, 26},
	15: {8, 27}, 18: {17, 19},
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
	compounds := map[[2]int]int{
		{8, 0}: 9, {8, 1}: 10, {8, 20}: 11,
		{13, 4}: 14, {13, 5}: 15, {13, 20}: 16,
		{18, 20}: 19,
	}
	if idx, ok := compounds[[2]int{first, second}]; ok {
		return idx
	}
	return -1
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
	inputFd  *os.File
	uinputFd *os.File
	korean   bool
	shifted  bool
	ctrl_or_alt bool
	hangul   HangulState
	patcher  *KeymapPatcher
	lastChar rune // 현재 디스크에 패치된 문자 (0=원본)
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

	log.Println("[UINPUT] 디바이스 생성 완료")
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

func (d *Daemon) writeEvent(typ uint16, code uint16, value int32) error {
	buf := make([]byte, inputEventSize)
	binary.LittleEndian.PutUint64(buf[0:8], 0)
	binary.LittleEndian.PutUint64(buf[8:16], 0)
	binary.LittleEndian.PutUint16(buf[16:18], typ)
	binary.LittleEndian.PutUint16(buf[18:20], code)
	binary.LittleEndian.PutUint32(buf[20:24], uint32(value))
	fd := int(d.uinputFd.Fd())
	_, err := syscall.Write(fd, buf)
	return err
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
func (d *Daemon) outputChar(char rune, backspaces int) {
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
		log.Printf("[OUTPUT] U+%04X (%c) 로드 완료 (디바이스 재생성)", char, char)
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

func (d *Daemon) resetCompose() {
	d.hangul = HangulState{}
}

func (d *Daemon) commitCurrent() {
	d.resetCompose()
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

	choIdx := -1
	jungIdx := -1
	jongIdx := -1
	isChoseong := false
	isJungseong := false

	if d.shifted {
		if idx, ok := choseongShiftMap[keyCode]; ok {
			isChoseong = true
			choIdx = idx
		} else if idx, ok := jungseongShiftMap[keyCode]; ok {
			isJungseong = true
			jungIdx = idx
		} else if idx, ok := choseongMap[keyCode]; ok {
			isChoseong = true
			choIdx = idx
		} else if idx, ok := jungseongMap[keyCode]; ok {
			isJungseong = true
			jungIdx = idx
		}
		if isChoseong {
			if idx, ok := jongseongShiftMap[keyCode]; ok {
				jongIdx = idx
			}
		}
	} else {
		if idx, ok := choseongMap[keyCode]; ok {
			isChoseong = true
			choIdx = idx
			if idx2, ok := jongseongMap[keyCode]; ok {
				jongIdx = idx2
			}
		}
		if idx, ok := jungseongMap[keyCode]; ok {
			isJungseong = true
			jungIdx = idx
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
			d.outputChar(choseongToJamo[choIdx], 0)
		} else if isJungseong {
			d.outputChar(jungseongToJamo[jungIdx], 0)
			d.resetCompose()
		}

	case stateChoseong:
		if isJungseong {
			d.hangul.jung = jungIdx
			d.hangul.state = stateJungseong
			d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, 0), 1)
		} else if isChoseong {
			d.hangul.cho = choIdx
			d.outputChar(choseongToJamo[choIdx], 0)
		}

	case stateJungseong:
		if isChoseong && jongIdx >= 0 {
			d.hangul.jong = jongIdx
			d.hangul.state = stateJongseong
			d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, d.hangul.jong), 1)
		} else if isJungseong {
			compoundJung := getCompoundJungseong(d.hangul.jung, jungIdx)
			if compoundJung >= 0 {
				d.hangul.jung = compoundJung
				d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, 0), 1)
			} else {
				d.resetCompose()
				d.outputChar(jungseongToJamo[jungIdx], 0)
			}
		} else if isChoseong {
			d.resetCompose()
			d.hangul.cho = choIdx
			d.hangul.state = stateChoseong
			d.outputChar(choseongToJamo[choIdx], 0)
		}

	case stateJongseong:
		if isJungseong {
			if split, ok := compoundJongseongSplit[d.hangul.jong]; ok {
				newCho := jongseongToChoseong[split[1]]
				d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, split[0]), 1)
				d.hangul.cho = newCho
				d.hangul.jung = jungIdx
				d.hangul.jong = 0
				d.hangul.state = stateJungseong
				d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, 0), 0)
			} else {
				newCho := jongseongToChoseong[d.hangul.jong]
				d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, 0), 1)
				d.hangul.cho = newCho
				d.hangul.jung = jungIdx
				d.hangul.jong = 0
				d.hangul.state = stateJungseong
				d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, 0), 0)
			}
		} else if isChoseong && jongIdx >= 0 {
			compound, ok := compoundJongseong[[2]int{d.hangul.jong, jongIdx}]
			if ok {
				d.hangul.jong = compound
				d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, d.hangul.jong), 1)
			} else {
				d.resetCompose()
				d.hangul.cho = choIdx
				d.hangul.state = stateChoseong
				d.outputChar(choseongToJamo[choIdx], 0)
			}
		} else if isChoseong {
			d.resetCompose()
			d.hangul.cho = choIdx
			d.hangul.state = stateChoseong
			d.outputChar(choseongToJamo[choIdx], 0)
		}
	}
}

func (d *Daemon) handleBackspace() {
	switch d.hangul.state {
	case stateJongseong:
		if split, ok := compoundJongseongSplit[d.hangul.jong]; ok {
			d.hangul.jong = split[0]
			d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, d.hangul.jong), 1)
		} else {
			d.hangul.jong = 0
			d.hangul.state = stateJungseong
			d.outputChar(composeSyllable(d.hangul.cho, d.hangul.jung, 0), 1)
		}
	case stateJungseong:
		d.hangul.state = stateChoseong
		d.outputChar(choseongToJamo[d.hangul.cho], 1)
	case stateChoseong:
		d.sendBackspace()
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
			d.commitCurrent()  // 한글 조합 중이면 확정
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

	// 초기 uinput 디바이스 생성
	if err := d.setupUinput(); err != nil {
		return fmt.Errorf("setup uinput: %w", err)
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
	buf := make([]byte, inputEventSize)
	eventCount := 0
	for {
		n, err := syscall.Read(fd, buf)
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if n != inputEventSize {
			continue
		}

		var ev InputEvent
		ev.Time.Sec = int64(binary.LittleEndian.Uint64(buf[0:8]))
		ev.Time.Usec = int64(binary.LittleEndian.Uint64(buf[8:16]))
		ev.Type = binary.LittleEndian.Uint16(buf[16:18])
		ev.Code = binary.LittleEndian.Uint16(buf[18:20])
		ev.Value = int32(binary.LittleEndian.Uint32(buf[20:24]))

		eventCount++
		if eventCount <= 10 || ev.Type == EV_KEY {
			log.Printf("[EVT] #%d type=%d code=%d val=%d", eventCount, ev.Type, ev.Code, ev.Value)
		}

		d.handleEvent(ev)
	}
}

func (d *Daemon) cleanup() {
	d.closeInput()
	if d.uinputFd != nil {
		_ = ioctl(d.uinputFd.Fd(), UI_DEV_DESTROY, 0)
		d.uinputFd.Close()
	}
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
