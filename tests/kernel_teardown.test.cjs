// Regression tests for the kernel-chain teardown end state.
//
// Background (docs/firmware-1360-bughunt.md, "2026-10-26 late"): freeing an
// armed pipe buffer when the app closes is what panics the console at
// reboot/shutdown -- the reported "the kernel exploit freezes the console
// after reboot". The 10/10-stable Y2JB reference (ps5-y2jb-autoloader
// @14fab6b, cleanTeardown()) ends with BOTH pipes carrying their original
// kmalloc buffers again ("the pair now looks like an ordinary used pipe").
// These tests drive the real KernelExploit methods against a mock kernel and
// assert exactly that end state for every pipe pair the chain crosses.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------------------
// int64-compatible pointer
// ---------------------------------------------------------------------------
class Ptr {
    constructor(low, hi = 0) { this.low = low >>> 0; this.hi = hi >>> 0; }
    static from(v) {
        const u = BigInt(v) & 0xffffffffffffffffn;
        return new Ptr(Number(u & 0xffffffffn), Number((u >> 32n) & 0xffffffffn));
    }
    get big() { return (BigInt(this.hi) << 32n) | BigInt(this.low); }
    add32(off) { return Ptr.from(this.big + BigInt(off | 0)); }
    toString() { return '0x' + this.big.toString(16); }
}

// ---------------------------------------------------------------------------
// kernel/user memory model
// ---------------------------------------------------------------------------
function makeMemory() {
    const bytes = new Map();
    return {
        bytes,
        r8(a) { return bytes.get(BigInt(a.big !== undefined ? a.big : a)) ?? 0; },
        w8(a, v) { bytes.set(BigInt(a.big !== undefined ? a.big : a), v & 0xff); },
        r32(a) {
            const b = BigInt(a.big !== undefined ? a.big : a);
            return ((this.r8(Ptr.from(b)) | (this.r8(Ptr.from(b + 1n)) << 8) |
                (this.r8(Ptr.from(b + 2n)) << 16) | (this.r8(Ptr.from(b + 3n)) << 24)) >>> 0);
        },
        w32(a, v) {
            const b = BigInt(a.big !== undefined ? a.big : a);
            for (let i = 0; i < 4; i++) this.w8(Ptr.from(b + BigInt(i)), (v >>> (8 * i)) & 0xff);
        },
        r64(a) {
            const b = BigInt(a.big !== undefined ? a.big : a);
            return Ptr.from(BigInt(this.r32(Ptr.from(b))) | (BigInt(this.r32(Ptr.from(b + 4n))) << 32n));
        },
        w64(a, v) {
            const b = BigInt(a.big !== undefined ? a.big : a);
            this.w32(Ptr.from(b), Number(BigInt(v.big !== undefined ? v.big : v) & 0xffffffffn));
            this.w32(Ptr.from(b + 4n), Number((BigInt(v.big !== undefined ? v.big : v) >> 32n) & 0xffffffffn));
        },
        writeString(a, s) { for (let i = 0; i < s.length; i++) this.w8(Ptr.from(BigInt(a.big !== undefined ? a.big : a) + BigInt(i)), s.charCodeAt(i)); },
    };
}

// ---------------------------------------------------------------------------
// pipe model: faithful FreeBSD-style ring (write copies to buffer+in and
// advances in/count; read copies from buffer+out; the ring resets to 0 when a
// read empties it). A read on an empty pipe BLOCKS -- modeled as an error so
// the wrong-fd bug in the old restorePipes() turns red here.
// ---------------------------------------------------------------------------
const PIPE = {count: 0x00, in: 0x04, out: 0x08, size: 0x0c, buffer: 0x10, pair: 0xe8};

function pipeHead(k, struct) {
    return {
        count: k.r32(struct.add32(PIPE.count)),
        in: k.r32(struct.add32(PIPE.in)),
        out: k.r32(struct.add32(PIPE.out)),
        size: k.r32(struct.add32(PIPE.size)),
        buffer: k.r64(struct.add32(PIPE.buffer)),
    };
}

function makePipeSyscallModel(k, fdMap, user) {
    return function pipeSys(number, fd, a, b) {
        const entry = fdMap.get(fd);
        if (number === 0x004) { // write(fd, src, len)
            if (!entry || entry.end !== 'w') throw new Error('mock: write to non-pipe fd ' + fd);
            const s = pipeHead(k, entry.struct);
            const len = Number(b);
            if (len > s.size - s.count) throw new Error('mock: pipe overflow');
            for (let i = 0; i < len; i++)
                k.w8(Ptr.from(s.buffer.big + BigInt((s.in + i) % s.size)), user.r8(a.add32(i)));
            k.w32(entry.struct.add32(PIPE.in), (s.in + len) % s.size);
            k.w32(entry.struct.add32(PIPE.count), s.count + len);
            return len;
        }
        if (number === 0x003) { // read(fd, dst, len)
            if (!entry || entry.end !== 'r') throw new Error('mock: read from non-pipe fd ' + fd);
            const s = pipeHead(k, entry.struct);
            const len = Number(b);
            if (s.count === 0)
                throw new Error('MOCK-BLOCK: read on an empty pipe (fd ' + fd + ') -- on the console this hangs the ROP worker');
            const take = Math.min(len, s.count);
            for (let i = 0; i < take; i++)
                user.w8(a.add32(i), k.r8(Ptr.from(s.buffer.big + BigInt((s.out + i) % s.size))));
            let count = s.count - take;
            let inPos = s.in, outPos = (s.out + take) % s.size;
            if (count === 0) { inPos = 0; outPos = 0; } // ring resets when emptied
            k.w32(entry.struct.add32(PIPE.in), inPos);
            k.w32(entry.struct.add32(PIPE.out), outPos);
            k.w32(entry.struct.add32(PIPE.count), count);
            return take;
        }
        if (number === 0x006) return 0; // close
        throw new Error('mock: unmodeled syscall 0x' + number.toString(16));
    };
}

// ---------------------------------------------------------------------------
// vm loader for the real sources (imports stripped, class exposed)
// ---------------------------------------------------------------------------
function loadRelapseExploit(context) {
    const file = path.join(__dirname, '../relapse-stable/src/relapse_exploit.js');
    let source = fs.readFileSync(file, 'utf8');
    source = source.replace(/^import .*;\s*$/gm, '');
    source = source.replace('export async function runKernelExploit', 'async function runKernelExploit');
    source += '\nglobalThis.__KernelExploit = KernelExploit;\n';
    vm.runInContext(source, context);
    return context.__KernelExploit;
}

function loadKexp(context) {
    const file = path.join(__dirname, '../relapse-stable/src/kexp.js');
    let source = fs.readFileSync(file, 'utf8');
    source = source.replace(/^import .*;\s*$/gm, '');
    source = source.replace(/^export /gm, '');
    source += '\nglobalThis.__kexp = {' +
        ' prepareShellcodePipes,' +
        ' restoreShellcodePipes: typeof restoreShellcodePipes === "undefined" ? null : restoreShellcodePipes,' +
        ' spawnAndJoin: typeof spawnAndJoin === "undefined" ? null : spawnAndJoin' +
        '};\n';
    vm.runInContext(source, context);
    return context.__kexp;
}

// ---------------------------------------------------------------------------
// world: synthetic offsets + kernel layout shared by the tests
// ---------------------------------------------------------------------------
const KBASE = 0xffff000000100000n;
const MASTER_STRUCT = 0xffff000000200000n;
const VICTIM_STRUCT = 0xffff000000201000n;
const MASTER_BUF = 0xffff000000300000n;
const VICTIM_BUF = 0xffff000000310000n;
const KEXP_MASTER_STRUCT = 0xffff000000202000n;
const KEXP_VICTIM_STRUCT = 0xffff000000203000n;
const KEXP_MASTER_BUF = 0xffff000000320000n;
const KEXP_VICTIM_BUF = 0xffff000000330000n;
const FDP = 0xffff000000400000n;
const FILE_TABLE = 0xffff000000410000n;
const PROC_FD_SLOT = 0xffff000000420000n;
const PIPE_SIZE = 0x4000;

const OFFSETS = {
    firmware: 'mock',
    allproc: 0x500, kernelData: 0x600, kernelPid: 0, nodeMutex: 0x700, rootvnode: 0x800,
    kaslr: {mode: 'rtmsg2', retStatic: 0x900, retLow16: 0x900},
    oid: {
        originalKind: 0x80048002, writableKind: 0x70048002,
        a: {kind: 0x1010, kindByte3: 0x1013, arg1: 0x1018, arg1Byte1: 0x1019, arg1Value: 0x1040, deadSink: 0x1050},
        b: {kind: 0x1060, kindByte3: 0x1063, arg1: 0x1068, arg1Value: 0x1080, visible: 0x1090},
        c: {kind: 0x10a0, arg1: 0x10a8, arg1Value: 0x10c0, mib: [9, 8]},
    },
    walkCounter: {addr: 0x1100, mib: [9, 7]},
    rodataProbe: {rva: 0x1200, text: '_aio_submit_cmd'},
    aio: {
        waiterSize: 0x38, requestSize: 0x28,
        group: {num: 0x0, state: 0x8, waiters: 0x50},
        idTable: {pages: 0x220, slotStride: 0x30, entryType: 0x160},
    },
    proc: {pid: 0xbc, ucred: 0x40, fd: 0x48, aioInfo: 0xc38, dynlib: 0x3e8},
    ucred: {
        uid: 0x4, ruid: 0x8, svuid: 0xc, ngroups: 0x10, rgid: 0x14, svgid: 0x18,
        sceAuthId: 0x58, sceCaps: 0x60, sceCaps1: 0x68, sceAttrs: 0x80,
    },
    sysCoreAuthId: {lo: 0x7, hi: 0x1},
    filedesc: {files: 0x00, cdir: 0x08, rdir: 0x10, jdir: 0x18},
    filedescTable: {nfiles: 0x00, ofiles: 0x08, entryStride: 0x30, fileData: 0x00},
    pipe: {...PIPE, defaultSize: PIPE_SIZE},
    dynlib: {syscallStart: 0xf0, syscallEnd: 0xf8, restrictFlags: 0x118, libkernelRef: 0x18},
};

function bootWorld() {
    const k = makeMemory();
    const user = makeMemory();
    const userNext = {at: 0x1000};

    const context = {
        window: {KRW: OFFSETS, fw_str: 'mock'},
        location: {search: ''},
        URLSearchParams,
        int64: Ptr,
        setTimeout,
        console,
    };
    context.globalThis = context;
    vm.createContext(context);
    const KernelExploit = loadRelapseExploit(context);

    const p = {
        malloc(size) {
            const base = userNext.at;
            userNext.at += (size + 15) & ~15;
            return Ptr.from(base);
        },
        read1: (a) => user.r8(a),
        read2: (a) => user.r32(a) & 0xffff,
        read4: (a) => user.r32(a),
        read8: (a) => user.r64(a),
        write1: (a, v) => user.w8(a, v),
        write2: (a, v) => user.w32(a, v & 0xffff),
        write4: (a, v) => user.w32(a, v),
        write8: (a, v) => user.w64(a, v),
        stringify(s) {
            const a = Ptr.from(userNext.at);
            userNext.at += (s.length + 16) & ~15;
            for (let i = 0; i < s.length; i++) user.w8(a.add32(i), s.charCodeAt(i));
            user.w8(a.add32(s.length), 0);
            return a;
        },
    };

    const fdMap = new Map();
    const chain = {
        async syscall(number, ...args) {
            const rv = pipeSysModel(number, ...args);
            return Ptr.from(BigInt(rv | 0));
        },
    };
    const pipeSysModel = makePipeSyscallModel(k, fdMap, user);

    // Kernel layout: both pipe pairs carry their real kmalloc buffers.
    for (const [struct, buf] of [
        [MASTER_STRUCT, MASTER_BUF], [VICTIM_STRUCT, VICTIM_BUF],
        [KEXP_MASTER_STRUCT, KEXP_MASTER_BUF], [KEXP_VICTIM_STRUCT, KEXP_VICTIM_BUF],
    ]) {
        const s = Ptr.from(struct);
        k.w32(s.add32(PIPE.count), 0);
        k.w32(s.add32(PIPE.in), 0);
        k.w32(s.add32(PIPE.out), 0);
        k.w32(s.add32(PIPE.size), PIPE_SIZE);
        k.w64(s.add32(PIPE.buffer), Ptr.from(buf));
        k.w64(s.add32(PIPE.pair), s);
    }

    // Fds for the exploit pair (10/11 master r/w, 20/21 victim r/w).
    fdMap.set(10, {struct: Ptr.from(MASTER_STRUCT), end: 'r'});
    fdMap.set(11, {struct: Ptr.from(MASTER_STRUCT), end: 'w'});
    fdMap.set(20, {struct: Ptr.from(VICTIM_STRUCT), end: 'r'});
    fdMap.set(21, {struct: Ptr.from(VICTIM_STRUCT), end: 'w'});

    // The rodata probe string the crossing verifies itself with.
    k.writeString(Ptr.from(KBASE + BigInt(OFFSETS.rodataProbe.rva)), OFFSETS.rodataProbe.text);

    const target = new KernelExploit(p, chain, () => {});
    target.kbase = Ptr.from(KBASE);
    target.master = {label: 'master', readFd: 10, writeFd: 11, pipe: Ptr.from(MASTER_STRUCT)};
    target.victim = {label: 'victim', readFd: 20, writeFd: 21, pipe: Ptr.from(VICTIM_STRUCT)};
    target.fds.push(10, 11, 20, 21);
    target.workersReleased = true;
    target.descriptorsClosed = true;

    // Slow sysctl window: mibA sets the low half, mibC the high half, mibB
    // reads/writes the windowed address.
    const mA = 'mA', mB = 'mB', mC = 'mC';
    target.mibA = mA; target.mibB = mB; target.mibC = mC;
    let winLow = 0, winHigh = 0;
    const windowAddr = () => Ptr.from((BigInt(winHigh) << 32n) | BigInt(winLow));
    target.sysctlWriteInt = async (mib, v) => {
        if (mib === mA) { winLow = v >>> 0; return 0; }
        if (mib === mC) { winHigh = v >>> 0; return 0; }
        if (mib === mB) { k.w32(windowAddr(), v); return 0; }
        return -1;
    };
    target.sysctlReadInt = async (mib) => {
        if (mib === mB) return {rv: 0, value: k.r32(windowAddr())};
        return {rv: 0, value: 0};
    };
    target.oidKind = async (mib) => {
        if (mib === mB) return k.r32(Ptr.from(KBASE + BigInt(OFFSETS.oid.b.visible))) ? k.r32(Ptr.from(KBASE + BigInt(OFFSETS.oid.b.kind))) : null;
        return k.r32(Ptr.from(KBASE + BigInt(OFFSETS.oid.a.kind)));
    };

    return {k, user, context, target, fdMap, loadKexp: () => loadKexp(context)};
}

// Simulate the arming state a completed chain leaves behind: the sysctl OIDs
// are flipped/writable and the exploit pair is crossed with the 1-byte probe
// pending (exactly what locatePipes()+crossPipes() expect).
async function crossExploitPair(target, k) {
    k.w32(Ptr.from(MASTER_STRUCT + BigInt(PIPE.count)), 1);
    k.w32(Ptr.from(MASTER_STRUCT + BigInt(PIPE.in)), 1);
    k.w32(Ptr.from(MASTER_STRUCT + BigInt(PIPE.out)), 0);
    k.w32(Ptr.from(KBASE + BigInt(OFFSETS.oid.a.kind)), OFFSETS.oid.writableKind);
    k.w32(Ptr.from(KBASE + BigInt(OFFSETS.oid.b.kind)), OFFSETS.oid.writableKind);
    k.w32(Ptr.from(KBASE + BigInt(OFFSETS.oid.c.kind)), OFFSETS.oid.writableKind);
    k.w32(Ptr.from(KBASE + BigInt(OFFSETS.oid.b.visible)), 1);
    const ok = await target.crossPipes();
    assert.equal(ok, true, 'crossPipes() must succeed against the mock kernel');
}

function assertOrdinaryPipe(k, struct, realBuffer, label) {
    const head = pipeHead(k, Ptr.from(struct));
    assert.equal(head.buffer.big, BigInt(realBuffer),
        label + '.buffer must be its real kmalloc buffer again (got ' + head.buffer.toString() +
        ') -- freeing an armed/NULL pipe buffer at app close is the reboot panic');
    assert.equal(head.size, PIPE_SIZE, label + '.size must be restored');
    assert.equal(head.count, 0, label + '.count must be zeroed');
    assert.equal(head.in, 0, label + '.in must be zeroed');
    assert.equal(head.out, 0, label + '.out must be zeroed');
}

// ---------------------------------------------------------------------------
// Test A: the full teardown must leave BOTH pipes of the exploit pair as
// ordinary used pipes (Y2JB restoreRealBuffers end state).
// ---------------------------------------------------------------------------
test('teardown restores the real pipe buffers of the crossed exploit pair', async () => {
    const {k, target} = bootWorld();
    await crossExploitPair(target, k);

    // Escalation snapshot (fd_jdir write-back) so restoreEscalation() runs the
    // same path it does on the console.
    target.escalationOrig = {
        fdp: Ptr.from(FDP),
        cdir: Ptr.from(0xffff000000500000n),
        rdir: Ptr.from(0xffff000000500000n),
        jdir: Ptr.from(0xffff000000501000n),
        dyn: null, syscallStart: null, syscallEnd: null, restrictFlags: null, libkernelRef: null,
    };

    let teardownError = null;
    let clean = null;
    try {
        clean = await target.restoreKernelState();
    } catch (e) {
        teardownError = e;
    }

    assert.equal(teardownError, null,
        'restoreKernelState() must not throw/hang (saw: ' + teardownError + ')');
    assert.equal(clean, true, 'teardown must verify clean');

    assertOrdinaryPipe(k, MASTER_STRUCT, MASTER_BUF, 'master');
    assertOrdinaryPipe(k, VICTIM_STRUCT, VICTIM_BUF, 'victim');
});

// ---------------------------------------------------------------------------
// Test B: when the real buffers were never saved, the fallback must still not
// leave a pipe armed (both buffers NULL at worst -- never a struct pointer).
// ---------------------------------------------------------------------------
test('teardown fallback disarms both pipes when no real buffers were saved', async () => {
    const {k, target} = bootWorld();
    await crossExploitPair(target, k);
    target.savedBuffers = null;

    let teardownError = null;
    try {
        await target.restorePipes();
    } catch (e) {
        teardownError = e;
    }
    assert.equal(teardownError, null, 'fallback teardown must not throw/hang (saw: ' + teardownError + ')');

    for (const [label, struct] of [['master', MASTER_STRUCT], ['victim', VICTIM_STRUCT]]) {
        const head = pipeHead(k, Ptr.from(struct));
        const armed = head.buffer.big === MASTER_STRUCT || head.buffer.big === VICTIM_STRUCT ||
            head.buffer.big === KEXP_MASTER_STRUCT || head.buffer.big === KEXP_VICTIM_STRUCT;
        assert.equal(armed, false,
            label + '.buffer still points at a pipe struct (' + head.buffer.toString() + ') -- that is the armed state that panics at close');
    }
});

// ---------------------------------------------------------------------------
// Test C: the shellcode pipe pair kexp.js crosses must also come back with its
// real buffers before the process can close.
// ---------------------------------------------------------------------------
test('kexp shellcode pipe pair is restored after the shellcode returns', async () => {
    const {k, target, loadKexp} = bootWorld();
    const kexp = loadKexp();
    assert.equal(typeof kexp.prepareShellcodePipes, 'function',
        'kexp.js must expose prepareShellcodePipes');
    assert.equal(typeof kexp.restoreShellcodePipes, 'function',
        'kexp.js must expose restoreShellcodePipes -- the shellcode pair is currently left armed and kills the console at close');

    // filedesc table walk for pipeOf(): procFdAddr -> table -> file -> pipe.
    const fdOf = (fd) => Ptr.from(FILE_TABLE + BigInt(0x08 + fd * 0x30));
    k.w64(Ptr.from(PROC_FD_SLOT), Ptr.from(FILE_TABLE));
    for (const [fd, struct] of [[30, KEXP_MASTER_STRUCT], [32, KEXP_VICTIM_STRUCT]]) {
        const file = Ptr.from(0xffff000000430000n + BigInt(fd * 0x40));
        k.w64(fdOf(fd), file);
        k.w64(file, Ptr.from(struct));
    }

    const krw = {
        procFdAddr: Ptr.from(PROC_FD_SLOT),
        read1: (a) => k.r8(a),
        read4: (a) => k.r32(a),
        read8: (a) => k.r64(a),
        write1: (a, v) => k.w8(a, v),
        write4: (a, v) => k.w32(a, v),
        write8: (a, v) => k.w64(a, v),
    };
    const master = {readFd: 30, writeFd: 31};
    const victim = {readFd: 32, writeFd: 33};

    const saved = await kexp.prepareShellcodePipes(krw, master, victim, () => {});
    assert.ok(saved, 'prepareShellcodePipes() must return the saved real buffers');

    // The pair is now crossed: the master buffer points at the victim struct.
    let head = pipeHead(k, Ptr.from(KEXP_MASTER_STRUCT));
    assert.equal(head.buffer.big, KEXP_VICTIM_STRUCT, 'crossing should arm the shellcode pair');

    await kexp.restoreShellcodePipes(krw, master, victim, saved, () => {});
    assertOrdinaryPipe(k, KEXP_MASTER_STRUCT, KEXP_MASTER_BUF, 'kexp master');
    assertOrdinaryPipe(k, KEXP_VICTIM_STRUCT, KEXP_VICTIM_BUF, 'kexp victim');
});

// ---------------------------------------------------------------------------
// Test D: spawnAndJoin must NOT wait on pthread_join when the firmware has no
// pthread_detach offset. No offsets/*.js file defines pthread_detach, so this
// is the real path on every supported firmware. A join parks the ROP worker in
// the kernel: the app cannot close, the pipes stay armed, and the console hangs
// at "prepare to turn off" until the power button is held. 2026-10-26n.
// ---------------------------------------------------------------------------
function makeSpawnFixture(calls) {
    return {
        chain: {
            async call(addr, ...args) {
                calls.push({addr: addr.toString(), argc: args.length});
                return Ptr.from(0);
            },
        },
        p: {
            malloc: () => Ptr.from(0x1000),
            write8: () => {},
            read8: () => Ptr.from(0),
            stringify: () => Ptr.from(0x2000),
        },
    };
}

test('spawnAndJoin returns without joining when pthread_detach is unresolved', async () => {
    const {context, loadKexp} = bootWorld();
    const kexp = loadKexp();
    assert.equal(typeof kexp.spawnAndJoin, 'function',
        'kexp.js must expose spawnAndJoin so the no-join path stays testable');

    const calls = [];
    const {chain, p} = makeSpawnFixture(calls);
    const symbols = {
        libkernel: {
            base: Ptr.from(KBASE),
            offsets: {pthread_create_name_np: 0x21890},
        },
    };

    const out = await kexp.spawnAndJoin(
        Ptr.from(0x3000), Ptr.from(0x4000), symbols, p, chain, () => {});

    assert.equal(calls.length, 1,
        'spawnAndJoin must call pthread_create once and return without joining ' +
        '(saw ' + calls.length + ' chain calls: ' + JSON.stringify(calls) + ')');
    assert.equal(out.detached, true,
        'spawnAndJoin must report detached:true when it skips the join');
    assert.equal(out.joinResult, 0,
        'spawnAndJoin must report joinResult 0 so runKexp does not treat the run as a crash');
});

// ---------------------------------------------------------------------------
// Test E: flipOidKind must stop at the first mis-aimed write instead of
// firing more heads into the neighbouring oid field. On B, kindByte3+1 IS
// oid_arg1 (0x028cee57 -> 0x028cee58), so one extra head is the difference
// between "the flip failed, REBOOT" and "borrowed into oid_arg1". 2026-10-26o.
// ---------------------------------------------------------------------------
function flipFixture(sequence) {
    const {target} = bootWorld();
    const lines = [];
    target.onScreen = (msg) => lines.push(String(msg));
    let cancels = 0;
    target.oidKind = async () => (sequence.length ? sequence.shift() : null);
    target.sysInt = async () => { cancels++; return 0; };
    const reclaim = {
        dangling: {ids: Ptr.from(0x1000)},
        firstPending: 0,
        heads: 8,
    };
    return {target, lines, reclaim, cancels: () => cancels};
}

test('flipOidKind reports OVERSHOT and fires once when the kind lands below target', async () => {
    const {target, lines, reclaim, cancels} = flipFixture([0x80048002, 0x60048002]);
    const ok = await target.flipOidKind('ARM-C', reclaim, 'mB', 0x70048002);
    assert.equal(ok, false, 'an overshoot must fail the flip');
    assert.equal(cancels(), 1, 'the overshoot must stop after the one bad head');
    assert.ok(lines.some((l) => l.includes('OVERSHOT')),
        'the report must name the overshoot (saw: ' + lines.join(' | ') + ')');
});

test('flipOidKind stops after one head when the kind walks to an unknown value', async () => {
    const {target, lines, reclaim, cancels} = flipFixture([0x80048002, 0x75048002, 0x70048002]);
    const ok = await target.flipOidKind('ARM-C', reclaim, 'mB', 0x70048002);
    assert.equal(ok, false, 'an unexpected intermediate kind must fail the flip');
    assert.equal(cancels(), 1,
        'the second head must not fire after the kind left its original value ' +
        '(saw ' + cancels() + ')');
    assert.ok(lines.some((l) => l.includes('mis-aimed')),
        'the report must say the waiter target is mis-aimed (saw: ' + lines.join(' | ') + ')');
});

test('flipOidKind still completes when dead heads precede the live head', async () => {
    const {target, reclaim, cancels} = flipFixture([0x80048002, 0x80048002, 0x70048002]);
    const ok = await target.flipOidKind('ARM-C', reclaim, 'mB', 0x70048002);
    assert.equal(ok, true, 'a dead head followed by a live head must still flip');
    assert.equal(cancels(), 2, 'exactly two heads: one dead, one live');
});

test('spawnAndJoin detaches instead of joining when pthread_detach resolves', async () => {
    const {context, loadKexp} = bootWorld();
    const kexp = loadKexp();

    const calls = [];
    const {chain, p} = makeSpawnFixture(calls);
    const symbols = {
        libkernel: {
            base: Ptr.from(KBASE),
            offsets: {pthread_create_name_np: 0x21890, pthread_detach: 0x21900},
        },
    };

    const out = await kexp.spawnAndJoin(
        Ptr.from(0x3000), Ptr.from(0x4000), symbols, p, chain, () => {});

    assert.equal(calls.length, 2,
        'spawnAndJoin must call pthread_create then pthread_detach ' +
        '(saw ' + calls.length + ' chain calls)');
    assert.equal(out.detached, true, 'detach path must report detached:true');
    assert.equal(out.joinResult, 0, 'detach path must not report a join result');
});