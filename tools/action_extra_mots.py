# -*- coding: utf-8 -*-
"""给定角色动作表，找出每个动作“可能引用了但没写在 saveMotId 里的 mot”。

判定来源（全部是数据层可见的）：
1. 同族邻居：同一个 mot 高半字节（例如 0x348x 一族）里存在轨文件、但动作表没列的 mot；
2. +0x100 平行轨：动作表列出的 mot 加 0x100 后存在轨文件（348a -> 358a 这类）；
3. 控制类型派生（CT3 蓄力型）：motionId02/04 每段 +2；松手段位 slot5+1..slot6-1。

用法: python action_extra_mots.py <char_id> [char_id...]
"""
import glob
import os
import struct
import sys

DATA = r'D:\Games\Relink\gen\extracted\system\player\data'
PL = r'D:\Games\Relink\gen\extracted\pl'

CT3 = 0xDF037954


class R:
    def __init__(self, b):
        self.b, self.i = b, 0

    def u8(self):
        v = self.b[self.i]
        self.i += 1
        return v

    def take(self, n):
        v = self.b[self.i:self.i + n]
        self.i += n
        return v

    def up(self, f, n):
        v = struct.unpack_from(f, self.b, self.i)[0]
        self.i += n
        return v


def read(r, d=0):
    c = r.u8()
    if c <= 0x7f: return c
    if c >= 0xe0: return c - 0x100
    if 0x80 <= c <= 0x8f: return {read(r, d + 1): read(r, d + 1) for _ in range(c & 0xf)}
    if 0x90 <= c <= 0x9f: return [read(r, d + 1) for _ in range(c & 0xf)]
    if 0xa0 <= c <= 0xbf: return r.take(c & 0x1f).decode('utf-8', 'replace')
    if c == 0xc0: return None
    if c == 0xc2: return False
    if c == 0xc3: return True
    if c == 0xc4: return r.take(r.u8())
    if c == 0xc5: return r.take(r.up('>H', 2))
    if c == 0xc6: return r.take(r.up('>I', 4))
    if c == 0xca: return r.up('>f', 4)
    if c == 0xcb: return r.up('>d', 8)
    if c == 0xcc: return r.u8()
    if c == 0xcd: return r.up('>H', 2)
    if c == 0xce: return r.up('>I', 4)
    if c == 0xcf: return r.up('>Q', 8)
    if c == 0xd0: return r.up('>b', 1)
    if c == 0xd1: return r.up('>h', 2)
    if c == 0xd2: return r.up('>i', 4)
    if c == 0xd3: return r.up('>q', 8)
    if c == 0xd9: return r.take(r.u8()).decode('utf-8', 'replace')
    if c == 0xda: return r.take(r.up('>H', 2)).decode('utf-8', 'replace')
    if c == 0xdb: return r.take(r.up('>I', 4)).decode('utf-8', 'replace')
    if c == 0xdc: return [read(r, d + 1) for _ in range(r.up('>H', 2))]
    if c == 0xdd: return [read(r, d + 1) for _ in range(r.up('>I', 4))]
    if c == 0xde: return {read(r, d + 1): read(r, d + 1) for _ in range(r.up('>H', 2))}
    if c == 0xdf:
        n = r.up('>I', 4)
        return [(read(r, d + 1), read(r, d + 1)) for _ in range(n)]
    raise ValueError(hex(c))


def load_actions(char):
    p = os.path.join(DATA, char, char + '_action.msg')
    if not os.path.exists(p):
        return []
    return [dict(v) for _, v in read(R(open(p, 'rb').read()))]


def track_motions(char):
    out = {}
    for f in glob.glob(os.path.join(PL, char, char + '_*_seq_edit_*.xml')):
        mot = os.path.basename(f).split('_')[1].lower()
        out.setdefault(mot, 0)
        out[mot] += 1
    return out


def slot(rec, n):
    key = 'saveMotId%02d_' % n
    v = (rec.get(key) or '').strip().lower()
    return v if v and v != '-' else None


def analyze(char):
    recs = load_actions(char)
    tracks = track_motions(char)
    trackset = set(tracks)
    referenced = set()
    for rec in recs:
        for i in range(1, 13):
            v = slot(rec, i)
            if v:
                referenced.add(v)

    print('=' * 70)
    print('%s  动作 %d 个, 有轨 mot %d 个 (其中动作表引用 %d)' % (
        char, len(recs), len(trackset), len(referenced & trackset)))

    for rec in recs:
        listed = [slot(rec, i) for i in range(1, 13)]
        used = [v for v in listed if v]
        if not used:
            continue
        cth = int(rec.get('controlTypeHash_', '0'))
        extras = []

        # 1. 同族邻居（mot >> 4 相同）
        for m in used:
            try:
                base = int(m, 16) >> 4
            except ValueError:
                continue
            for t in trackset:
                try:
                    if int(t, 16) >> 4 == base and t not in used:
                        extras.append(('同族', t))
                except ValueError:
                    pass

        # 2. +0x100 平行轨
        for m in used:
            try:
                t = '%04x' % (int(m, 16) + 0x100)
            except ValueError:
                continue
            if t in trackset and t not in used:
                extras.append(('+0x100', t))

        # 3. CT3 派生
        if cth == CT3:
            for i in (2, 4):
                v = slot(rec, i)
                if v:
                    try:
                        t = '%04x' % (int(v, 16) + 2)
                    except ValueError:
                        continue
                    if t in trackset and t not in used:
                        extras.append(('CT3+2', t))
            s5, s6 = slot(rec, 5), slot(rec, 6)
            if s5 and s6:
                try:
                    a, b = int(s5, 16), int(s6, 16)
                    for k in range(a + 1, b):
                        t = '%04x' % k
                        if t in trackset and t not in used:
                            extras.append(('CT3档位', t))
                except ValueError:
                    pass

        if not extras:
            continue
        seen = set()
        uniq = []
        for src, t in extras:
            if (src, t) in seen:
                continue
            seen.add((src, t))
            uniq.append((src, t))
        print('\n[动作 %-5s] %s' % (rec.get('id_'), rec.get('actionName_')))
        print('  列出: %s' % ' '.join(used))
        print('  候选额外 mot: %s' % ', '.join('%s=%s' % (t, src) for src, t in uniq))
        for _, t in uniq:
            if t in referenced:
                print('    %s 已被其它动作引用' % t)
            elif t in trackset:
                print('    %s 有轨但没有任何动作引用 ← 隐藏/遗留候选' % t)


if __name__ == '__main__':
    for c in (sys.argv[1:] or ['pl1400']):
        analyze(c)
