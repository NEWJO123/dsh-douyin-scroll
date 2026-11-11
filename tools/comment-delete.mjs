#!/usr/bin/env node
/**
 * tools/comment-delete.mjs —— 删除**自己**的评论（无头页面里 fetch，页面自己补签名）
 * ============================================================================
 * 背景：删评没有独立工具，2026-10-21 临时加。只允许删**登录号自己**的评论 ——
 * 在页面里带上 cid 打抖音自己的删除接口，服务端会校验"这条评论是不是你的"，
 * 不是自己的会返回错误，我们只负责把结果如实报出来。
 *
 * 用法:
 *   node tools/comment-delete.mjs --aweme <id> --cid <cid> [--dry]
 *
 * 输出一行 JSON：{ ok, http, status_code, error? }
 * ⚠️ ok 判据：接口 200 且 status_code=0。删没删真掉，用 api-comments.py 回读 cid 消失为准。
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const DRY = argv.includes('--dry')
const AWEME = String(argOf('--aweme', '')).trim()
const CID = String(argOf('--cid', '')).trim()

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME || !CID) { out({ ok: false, error: '用法: comment-delete.mjs --aweme <id> --cid <cid>' }); process.exit(1) }

try {
  const c = await openPage({ isolated: true })
  const chromed = c.status
  const cur = String(await c.ev('location.href'))
  if (!cur.includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(6000)
  }

  if (DRY) {
    out({ ok: true, dry: true, aweme_id: AWEME, cid: CID, chrome: chromed })
    c.close()
    await sleep(200)
    throw { __done: true }
  }

  const js = `(async function(){
    var AWEME = ${JSON.stringify(AWEME)};
    var CID = ${JSON.stringify(CID)};
    var COMMON = {
      device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
      pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
      cookie_enabled:'true', screen_width:'1920', screen_height:'1080',
      browser_language:'zh-CN', browser_platform:'Win32',
      browser_name:'Chrome', browser_version:'141.0.0.0',
      engine_name:'Blink', engine_version:'141.0.0.0',
      os_name:'Windows', os_version:'10', platform:'PC'
    };
    function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
    var COMMON2 = Object.assign({}, COMMON, { aweme_id: AWEME, cid: CID });
    // 两个已知端点形态都试：GET /comment/list/delete/ 是抓包看到的；POST /comment/delete/ 是老文档
    var attempts = [];
    // A) GET list/delete（页面抓包形态）
    try {
      var u1 = '/aweme/v1/web/comment/list/delete/?' + qs(Object.assign({}, COMMON2, { app_name: 'aweme' }));
      var r1 = await fetch(u1, { method: 'GET', credentials: 'include', headers: { 'Referer': 'https://www.douyin.com/' } });
      var t1 = await r1.text();
      var j1 = {};
      try { j1 = JSON.parse(t1) } catch (e) {}
      attempts.push({ via: 'GET list/delete', http: r1.status, status_code: j1.status_code, head: t1.slice(0, 160) });
      if (r1.status === 200 && (j1.status_code === 0 || j1.status_code === '0')) {
        return JSON.stringify({ ok: true, via: 'GET list/delete', http: r1.status, status_code: j1.status_code, attempts: attempts });
      }
    } catch (e) { attempts.push({ via: 'GET list/delete', error: String((e && e.message) || e) }); }
    // B) POST /comment/delete/
    try {
      var u2 = '/aweme/v1/web/comment/delete/?' + qs(Object.assign({}, COMMON, { app_name: 'aweme' }));
      var r2 = await fetch(u2, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.douyin.com/' },
        body: new URLSearchParams(Object.assign({}, COMMON2)).toString()
      });
      var t2 = await r2.text();
      var j2 = {};
      try { j2 = JSON.parse(t2) } catch (e) {}
      attempts.push({ via: 'POST delete', http: r2.status, status_code: j2.status_code, head: t2.slice(0, 160) });
      if (r2.status === 200 && (j2.status_code === 0 || j2.status_code === '0')) {
        return JSON.stringify({ ok: true, via: 'POST delete', http: r2.status, status_code: j2.status_code, attempts: attempts });
      }
    } catch (e) { attempts.push({ via: 'POST delete', error: String((e && e.message) || e) }); }
    return JSON.stringify({ ok: false, attempts: attempts });
  })()`

  const raw = await c.ev(js)
  c.close()
  await sleep(200)

  let res
  try { res = JSON.parse(raw) } catch { out({ ok: false, error: '页面没返回可解析结果', raw: String(raw).slice(0, 400) }); process.exit(1) }
  out({ ...res, aweme_id: AWEME, cid: CID, chrome: chromed })
} catch (e) {
  if (!(e && e.__done)) out({ ok: false, error: String(e?.message ?? e) })
}
