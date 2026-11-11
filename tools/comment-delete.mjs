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
  // ⭐ 2026-11-12（网络调研 + CDP 实测）：必须导航到**作品页**让抖音前端接管 XHR
  //    （prototype.open 被重写）—— 被 hook 的 XHR 发请求会自动补签名；
  //    fetch 没有被 hook ⇒ 裸奔 403（旧实现两条通道全用 fetch，就是败在这）。
  //    另：旧的 GET「列表删除」路径已被抖音下线（网关报路径不支持）—— 已从工具里移除。
  const workUrl = `https://www.douyin.com/video/${AWEME}`
  await c.send('Page.navigate', { url: workUrl })
  let sdk = false
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    sdk = (await c.ev(`(() => ({ sdk: typeof window.bdms === 'object' && !XMLHttpRequest.prototype.open.toString().includes('[native code]') }))()`)).sdk
    if (sdk) break
  }
  if (!sdk) { out({ ok: false, error: '页面签名 SDK 未就绪（30 秒）—— 重试一次通常就好' }); c.close(); await sleep(200); throw { __done: true } }
  if (DRY) { out({ ok: true, dry: true, aweme_id: AWEME, cid: CID, sdk: true, chrome: chromed }); c.close(); await sleep(200); throw { __done: true } }

  // POST /comment/delete/ —— 走被 hook 的 XHR（自动签名），不能换 fetch
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
    return await new Promise(function(resolve){
      var url = '/aweme/v1/web/comment/delete/?' + qs(Object.assign({}, COMMON, { app_name: 'aweme' }));
      var body = 'aweme_id=' + encodeURIComponent(AWEME) + '&cid=' + encodeURIComponent(CID);
      var x = new XMLHttpRequest();
      var done = function(){ resolve(JSON.stringify({ http: x.status, body: (x.responseText||'').slice(0, 400) })); };
      x.open('POST', url, true);
      x.withCredentials = true;
      x.timeout = 20000;
      x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      x.onload = done; x.onerror = done; x.ontimeout = done; x.onabort = done;
      x.send(body);
    });
  })()`

  const raw = await c.ev(js)
  c.close()
  await sleep(200)

  let res
  try { res = JSON.parse(raw) } catch { out({ ok: false, error: '页面没返回可解析结果', raw: String(raw).slice(0, 400) }); process.exit(1) }
  let j = {}
  try { j = JSON.parse(res.body || '{}') } catch { /* 非 JSON 如实报 */ }
  const ok = res.http === 200 && (j.status_code === 0 || j.status_code === '0')
  out({ ok, http: res.http, status_code: j.status_code ?? null, msg: j.msg || '', aweme_id: AWEME, cid: CID, chrome: chromed })
} catch (e) {
  if (!(e && e.__done)) out({ ok: false, error: String(e?.message ?? e) })
}
