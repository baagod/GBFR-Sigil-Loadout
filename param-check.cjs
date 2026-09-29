const fs = require('fs')
const dir = 'SigilLoadout/assets/'
const sb = JSON.parse(fs.readFileSync(dir + 'skillboard.json', 'utf8'))
const zh = JSON.parse(fs.readFileSync(dir + 'skillboard.zh.json', 'utf8'))

// 找"花耀七闪"那个类型
for (const c of sb) {
    for (const [ti, t] of c.types.entries()) {
        const name = (zh[t.hash] || {}).name || ''
        if (!name.includes('花耀七闪')) continue
        console.log('角色 ' + c.id + '  类型' + ti + '  ' + name + '   （类型 hash ' + t.hash + '）')
        const list = (zh[t.hash] || {}).rows || []
        // 类型自己的三条 + 各阶条目，按渲染顺序（也就是列表顺序）
        const rows = [...t.rows.map(r => ({ r, kind: '类型头' })), ...t.skills.flatMap(s => s.rows.map(r => ({ r, kind: s.label })))]
        rows.forEach((x, i) => {
            const raw = list[i] || ''
            const ph = [...raw.matchAll(/\{(\d+)\}/g)].map(m => m[1])
            console.log('  [' + i + '] ' + x.kind + '  hash=' + x.r.hash)
            console.log('      资产原文: ' + JSON.stringify(raw))
            console.log('      原文占位符: {' + ph.join('} {') + '}    → 界面显示为: {' + ph.map(n => Number(n) + 1).join('} {') + '}')
            console.log('      该行 values: ' + JSON.stringify(x.r.values))
            if (x.r.more && x.r.more.length) console.log('      第 2/3 组: ' + x.r.more.map(g => JSON.stringify(g.values)).join('  '))
        })
        console.log('')
    }
}
