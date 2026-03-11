/*
 * hangul_hook.c - Real-time Korean (Hangul) composition hook for reMarkable
 *
 * LD_PRELOAD hook that intercepts QInputMethodEvent::setCommitString()
 * to compose Hangul syllables in real-time (ㄱ+ㅏ → 가).
 *
 * Key techniques:
 * - malloc'd heap QArrayData for Qt-safe QString construction
 * - Event memory patching for replaceFrom/replaceLength (offsets 88/92)
 * - QKeyEvent constructor hook to reset composition state on Enter
 *   (Enter bypasses setCommitString, going through QKeyEvent directly)
 *
 * Build: zig cc -target aarch64-linux-musl -shared -fPIC -O2 -nostdlib -o hangul_hook.so hangul_hook.c
 */
typedef unsigned short uint16_t;
typedef unsigned int   uint32_t;
typedef unsigned long  uint64_t;
typedef long long      int64_t;
typedef unsigned long  size_t;
#define NULL ((void*)0)
#define RTLD_NEXT ((void*)(long)-1)
extern void *dlsym(void *handle, const char *symbol);
extern int open(const char *pathname, int flags, ...);
extern long write(int fd, const void *buf, unsigned long count);
extern int close(int fd);

#ifndef HANGUL_HOOK_ENABLE_LOG
#define HANGUL_HOOK_ENABLE_LOG 0
#endif

typedef struct { void *d; uint16_t *ptr; int64_t size; } QString6;

/* ── malloc via dlsym ── */
typedef void *(*malloc_t)(size_t);
static malloc_t real_malloc = NULL;

/* ── Event memory offsets (confirmed by v7c diagnostic) ── */
#define OFF_REPLACE_START  88
#define OFF_REPLACE_LENGTH 92

/* ── Korean tables ── */
#define HANGUL_BASE    0xAC00
#define JUNG_COUNT     21
#define JONG_COUNT     28
#define JAMO_CON_START 0x3131
#define JAMO_CON_END   0x314E
#define JAMO_VOW_START 0x314F
#define JAMO_VOW_END   0x3163

static const int jamo_to_cho[] = {
     0,  1, -1,  2, -1, -1,  3,  4,  5, -1, -1, -1,
    -1, -1, -1, -1,  6,  7,  8, -1,  9, 10, 11, 12,
    13, 14, 15, 16, 17, 18
};
static const int jamo_to_jong[] = {
     1,  2,  3,  4,  5,  6,  7, -1,  8,  9, 10, 11,
    12, 13, 14, 15, 16, 17, -1, 18, 19, 20, 21, 22,
    -1, 23, 24, 25, 26, 27
};
static const int jong_to_cho[] = {
    -1,  0,  1, -1,  2, -1, -1,  3,  5, -1, -1, -1,
    -1, -1, -1, -1,  6,  7, -1,  9, 10, 11, 12, 14,
    15, 16, 17, 18
};
static const uint16_t cho_to_jamo[] = {
    0x3131,0x3132,0x3134,0x3137,0x3138,0x3139,0x3141,
    0x3142,0x3143,0x3145,0x3146,0x3147,0x3148,0x3149,
    0x314A,0x314B,0x314C,0x314D,0x314E
};

static int get_compound_jong(int a, int b) {
    if(a==1&&b==19)return 3;  if(a==4&&b==22)return 5;
    if(a==4&&b==27)return 6;  if(a==8&&b==1) return 9;
    if(a==8&&b==16)return 10; if(a==8&&b==17)return 11;
    if(a==8&&b==19)return 12; if(a==8&&b==25)return 13;
    if(a==8&&b==26)return 14; if(a==8&&b==27)return 15;
    if(a==17&&b==19)return 18; return -1;
}
static int split_compound_jong(int c, int *f, int *s) {
    switch(c){
    case 3:*f=1;*s=19;return 1;  case 5:*f=4;*s=22;return 1;
    case 6:*f=4;*s=27;return 1;  case 9:*f=8;*s=1;return 1;
    case 10:*f=8;*s=16;return 1; case 11:*f=8;*s=17;return 1;
    case 12:*f=8;*s=19;return 1; case 13:*f=8;*s=25;return 1;
    case 14:*f=8;*s=26;return 1; case 15:*f=8;*s=27;return 1;
    case 18:*f=17;*s=19;return 1; default:return 0;
    }
}
static int get_compound_jung(int a, int b) {
    if(a==8&&b==0)return 9;   if(a==8&&b==1)return 10;
    if(a==8&&b==20)return 11; if(a==13&&b==4)return 14;
    if(a==13&&b==5)return 15; if(a==13&&b==20)return 16;
    if(a==18&&b==20)return 19; return -1;
}

static inline uint16_t compose_syl(int cho, int jung, int jong)
{ return (uint16_t)(HANGUL_BASE + (cho * JUNG_COUNT + jung) * JONG_COUNT + jong); }
static inline int is_con(uint16_t c) { return c >= JAMO_CON_START && c <= JAMO_CON_END; }
static inline int is_vow(uint16_t c) { return c >= JAMO_VOW_START && c <= JAMO_VOW_END; }

/* ── State ── */
#define ST_EMPTY 0
#define ST_CHO   1
#define ST_JUNG  2
#define ST_JONG  3

static int state = ST_EMPTY;
static int s_cho = -1, s_jung = -1, s_jong = -1;
static void reset(void) { state = ST_EMPTY; s_cho = s_jung = s_jong = -1; }

/*
 * Allocate a real heap QArrayData for a composed string.
 * Layout: {int ref, int pad, int64_t alloc, uint16_t data[4]}
 * Total: 24 bytes (header) + 8 bytes (data) = 32 bytes
 */
struct QStrHeap {
    int ref;
    int pad;
    int64_t alloc;
    uint16_t data[4];
};

static void make_qstr_heap(QString6 *out, uint16_t *text, int len) {
    if (!real_malloc)
        real_malloc = (malloc_t)dlsym(RTLD_NEXT, "malloc");
    if (!real_malloc) return;

    struct QStrHeap *h = (struct QStrHeap *)real_malloc(sizeof(struct QStrHeap));
    if (!h) return;

    h->ref = 1;    /* normal refcount — Qt manages this normally */
    h->pad = 0;
    h->alloc = 3;
    for (int i = 0; i < len && i < 4; i++)
        h->data[i] = text[i];
    for (int i = len; i < 4; i++)
        h->data[i] = 0;

    out->d = (void *)h;
    out->ptr = h->data;
    out->size = len;
}

/* ── Logging ── */
#if HANGUL_HOOK_ENABLE_LOG
static char logbuf[4096];
static int logpos = 0;
static int logcount = 0;
static void log_str(const char *s) { while (*s && logpos < 4000) logbuf[logpos++] = *s++; }
static void log_int(int v) {
    if (v < 0) { if (logpos < 4000) logbuf[logpos++] = '-'; v = -v; }
    char tmp[12]; int n = 0;
    do { tmp[n++] = '0' + (v % 10); v /= 10; } while (v > 0);
    while (n-- > 0 && logpos < 4000) logbuf[logpos++] = tmp[n];
}
static void log_hex4(uint32_t v) {
    const char *h = "0123456789abcdef";
    for (int i = 12; i >= 0; i -= 4)
        if (logpos < 4000) logbuf[logpos++] = h[(v >> i) & 0xf];
}
static void log_nl(void) { if (logpos < 4000) logbuf[logpos++] = '\n'; }
static void flush_log(void) {
    int fd = open("/home/root/bt-keyboard/hook_v9.txt", 0x41 | 0x400, 0644);
    if (fd >= 0) { write(fd, logbuf, logpos); close(fd); }
    logpos = 0;
}
#endif

/* ── Original function ── */
typedef void (*orig_scs_t)(void*, const void*, int, int);
static orig_scs_t orig_scs = NULL;

/*
 * commit_replace: heap-allocated QString + event memory patch.
 * 1. Allocate real heap QArrayData with composed text
 * 2. Call orig_scs(ev, &qs, 0, 0) — safe (proven by v7b)
 * 3. Patch rf/rl in event memory
 *
 * Qt can safely manage the heap QArrayData (increment/decrement/free).
 * Small memory leak (~32 bytes per compose) since our C code has no
 * destructor to decrement ref. Acceptable for text editing use case.
 */
static void commit_replace(void *ev, uint16_t *text, int len, int rf, int rl) {
    QString6 qs;
    make_qstr_heap(&qs, text, len);
    if (!qs.d) return;  /* malloc failed */
    orig_scs(ev, &qs, 0, 0);
    char *p = (char *)ev;
    *(int *)(p + OFF_REPLACE_START) = rf;
    *(int *)(p + OFF_REPLACE_LENGTH) = rl;
}

/* ── Hook: setCommitString ── */
void _ZN17QInputMethodEvent15setCommitStringERK7QStringii(
    void *ev, const QString6 *cs, int rf, int rl)
{
    if (!orig_scs) {
        orig_scs = (orig_scs_t)dlsym(RTLD_NEXT,
            "_ZN17QInputMethodEvent15setCommitStringERK7QStringii");
        if (!orig_scs) return;
    }

    if (!cs || !cs->ptr) {
        reset();
        return;
    }

#if HANGUL_HOOK_ENABLE_LOG
    if (logcount < 500) {
        logcount++;
        log_str("S["); log_int(logcount); log_str("]");
        if (cs->size > 0) log_hex4((uint32_t)cs->ptr[0]);
        else log_str("BS");
        log_str(" st="); log_int(state);
        log_nl(); flush_log();
    }
#endif

    /* ── Backspace (empty commit) ── */
    if (cs->size == 0) {
        uint16_t tmp[4];
        switch (state) {
        case ST_EMPTY:
            orig_scs(ev, cs, rf, rl);
            return;
        case ST_CHO:
            orig_scs(ev, cs, rf, rl);
            reset();
            return;
        case ST_JUNG:
            tmp[0] = (s_cho >= 0 && s_cho < 19) ? cho_to_jamo[s_cho] : 0x3131;
            commit_replace(ev, tmp, 1, -1, 1);
            s_jung = -1;
            state = ST_CHO;
            return;
        case ST_JONG: {
            int fj, sj;
            if (split_compound_jong(s_jong, &fj, &sj)) {
                s_jong = fj;
            } else {
                s_jong = -1;
                state = ST_JUNG;
            }
            tmp[0] = compose_syl(s_cho, s_jung, s_jong >= 0 ? s_jong : 0);
            commit_replace(ev, tmp, 1, -1, 1);
            return;
        }
        }
        return;
    }

    /* ── Multi-char: reset + passthrough ── */
    if (cs->size != 1) {
        reset();
        orig_scs(ev, cs, rf, rl);
        return;
    }

    uint16_t ch = cs->ptr[0];

    /* ── Non-Korean: reset + passthrough ── */
    if (!is_con(ch) && !is_vow(ch)) {
        reset();
        orig_scs(ev, cs, rf, rl);
        return;
    }

    int icon = is_con(ch), ivow = is_vow(ch);
    int ci = icon ? jamo_to_cho[ch - JAMO_CON_START] : -1;
    int ji = icon ? jamo_to_jong[ch - JAMO_CON_START] : -1;
    int vi = ivow ? (int)(ch - JAMO_VOW_START) : -1;
    uint16_t tmp[4];

    switch (state) {

    case ST_EMPTY:
        if (icon && ci >= 0) {
            s_cho = ci; state = ST_CHO;
            orig_scs(ev, cs, 0, 0);
        } else {
            orig_scs(ev, cs, 0, 0);
        }
        return;

    case ST_CHO:
        if (ivow) {
            s_jung = vi; state = ST_JUNG;
            tmp[0] = compose_syl(s_cho, s_jung, 0);
            commit_replace(ev, tmp, 1, -1, 1);
        } else if (icon && ci >= 0) {
            s_cho = ci;
            orig_scs(ev, cs, 0, 0);
        } else {
            reset();
            orig_scs(ev, cs, rf, rl);
        }
        return;

    case ST_JUNG:
        if (icon && ji >= 0) {
            s_jong = ji; state = ST_JONG;
            tmp[0] = compose_syl(s_cho, s_jung, s_jong);
            commit_replace(ev, tmp, 1, -1, 1);
        } else if (ivow) {
            int cmp = get_compound_jung(s_jung, vi);
            if (cmp >= 0) {
                s_jung = cmp;
                tmp[0] = compose_syl(s_cho, s_jung, 0);
                commit_replace(ev, tmp, 1, -1, 1);
            } else {
                reset();
                orig_scs(ev, cs, 0, 0);
            }
        } else if (icon && ci >= 0) {
            reset();
            s_cho = ci; state = ST_CHO;
            orig_scs(ev, cs, 0, 0);
        } else {
            reset();
            orig_scs(ev, cs, rf, rl);
        }
        return;

    case ST_JONG:
        if (ivow) {
            int fj, sj, nc;
            if (split_compound_jong(s_jong, &fj, &sj)) {
                nc = jong_to_cho[sj];
                if (nc < 0) { reset(); orig_scs(ev, cs, rf, rl); return; }
                s_jong = fj;
            } else {
                nc = jong_to_cho[s_jong];
                if (nc < 0) { reset(); orig_scs(ev, cs, rf, rl); return; }
                s_jong = -1;
            }
            tmp[0] = compose_syl(s_cho, s_jung, s_jong >= 0 ? s_jong : 0);
            tmp[1] = compose_syl(nc, vi, 0);
            commit_replace(ev, tmp, 2, -1, 1);
            s_cho = nc; s_jung = vi; s_jong = -1; state = ST_JUNG;
        } else if (icon && ji >= 0) {
            int cmp = get_compound_jong(s_jong, ji);
            if (cmp >= 0) {
                s_jong = cmp;
                tmp[0] = compose_syl(s_cho, s_jung, s_jong);
                commit_replace(ev, tmp, 1, -1, 1);
            } else {
                reset();
                s_cho = ci >= 0 ? ci : 0; state = ST_CHO;
                orig_scs(ev, cs, 0, 0);
            }
        } else if (icon && ci >= 0) {
            reset();
            s_cho = ci; state = ST_CHO;
            orig_scs(ev, cs, 0, 0);
        } else {
            reset();
            orig_scs(ev, cs, rf, rl);
        }
        return;
    }
}

/* ── Hook: QKeyEvent constructor ── */
/* Enter key bypasses setCommitString (goes as QKeyEvent directly).
 * Without this hook, composition state persists after Enter, causing
 * the next character to replace the newline via rf=-1,rl=1. */
typedef void (*orig_keyevent_t)(void*, int, int, int, const void*, int, unsigned short);
static orig_keyevent_t orig_keyevent = NULL;

void _ZN9QKeyEventC1EN6QEvent4TypeEi6QFlagsIN2Qt16KeyboardModifierEERK7QStringbt(
    void *self, int type, int key, int modifiers,
    const void *text, int autorep, unsigned short count)
{
    if (!orig_keyevent) {
        orig_keyevent = (orig_keyevent_t)dlsym(RTLD_NEXT,
            "_ZN9QKeyEventC1EN6QEvent4TypeEi6QFlagsIN2Qt16KeyboardModifierEERK7QStringbt");
        if (!orig_keyevent) return;
    }

    /* Key_Return=0x01000004, Key_Enter=0x01000005 */
    if (key == 0x01000004 || key == 0x01000005)
        reset();

    orig_keyevent(self, type, key, modifiers, text, autorep, count);
}
