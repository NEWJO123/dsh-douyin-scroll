/** 视频/图文共用的作品入口、页面签名请求和评论面板准备。 */
import { sleep } from './chrome.mjs'

const PHOTO_TYPES = new Set([68, 150])

export function parseWork(aweme, workUrl = '', awemeType = '') {
  const value = String(aweme || '').trim()
  let id = /^\d{15,25}$/.test(value) ? value : ''
  let route = ''
  for (const candidate of [id ? '' : value, workUrl].filter(Boolean)) {
    const url = new URL(candidate)
    const match = /^\/(video|note)\/(\d{15,25})\/?$/.exec(url.pathname)
    if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || !match || url.username || url.password || url.port) {
      throw new Error('作品地址必须是 https://www.douyin.com/video/<ID> 或 /note/<ID>')
    }
    if (id && id !== match[2]) throw new Error('作品 ID 与作品地址不一致')
    id = match[2]; route = match[1]
  }
  if (!id) throw new Error('缺少有效的作品 ID')
  let type = null
  if (awemeType !== '' && awemeType !== undefined && awemeType !== null) {
    if (!/^\d+$/.test(String(awemeType))) throw new Error('aweme_type 必须是非负整数')
    type = Number(awemeType)
    const typedRoute = PHOTO_TYPES.has(type) ? 'note' : 'video'
    // Web 详情可能把 /note/ 作品的 aweme_type 也返回为 0；真实 URL 优先。
    route ||= typedRoute
  }
  return { aweme_id: id, aweme_type: type, route,
    work_url: `https://www.douyin.com/${route || 'video'}/${id}` }
}

// 使用作品页面已接管的 XHR；不在插件外补写接口签名，也不重试发布。
export function pageRequest(method, url, body = null) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest()
    const done = () => resolve({ status: x.status, body: x.responseText || '' })
    x.open(method, url, true)
    x.withCredentials = true
    x.timeout = 20000
    if (body !== null) x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded')
    x.onload = done; x.onerror = done; x.ontimeout = done; x.onabort = done
    x.send(body)
  })
}

export const pageRequestSource = `(${pageRequest.toString()})`

export function publishReceipt(response) {
  let data
  try { data = JSON.parse(response.body) } catch { /* 空正文/非 JSON 都是未知结果 */ }
  const cid = data?.comment?.cid ? String(data.comment.cid) : ''
  const ok = response.status === 200 && data?.status_code === 0 && Boolean(cid)
  return { ok, cid, status_code: data?.status_code ?? null,
    outcome_unknown: !cid,
    error: ok ? undefined : '没有收到 status_code=0 和 cid；结果未确认，请先回读，勿自动重发' }
}

async function waitForWork(c, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let state
  do {
    state = await c.ev(`(() => ({
      url: location.href,
      sdk: typeof window.bdms === 'object' && !XMLHttpRequest.prototype.open.toString().includes('[native code]'),
      content: Boolean(document.querySelector('[data-e2e="feed-comment-icon"], #comment-input-container'))
    }))()`).catch(() => null)
    if (state?.sdk && state.content && new RegExp('/(video|note)/' + id + '(?:[/?#]|$)').test(state.url)) return state
    await sleep(500)
  } while (Date.now() < deadline)
  throw new Error(`作品页未就绪（正文=${Boolean(state?.content)}，页面签名=${Boolean(state?.sdk)}）；未发送。${state?.url || ''}`)
}

export async function prepareWorkPage(c, input, { timeoutMs = 25000 } = {}) {
  let work = parseWork(input.aweme, input.work_url, input.aweme_type)
  const focus = /^\d{15,25}$/.test(String(input.comment_id || '')) ? `?comment_id=${input.comment_id}` : ''
  await c.send('Page.navigate', { url: work.work_url + focus })
  const state = await waitForWork(c, work.aweme_id, timeoutMs)
  const loaded = parseWork(state.url)
  // 旧调用只有 ID 时，采用页面重定向后的真实路由；不把未知图文当视频发布。
  // 同一作品 ID 的 /video/ 可被站点重定向到 /note/，旧通知可能仍带 /video/。
  const detailUrl = '/aweme/v1/web/aweme/detail/?' + new URLSearchParams({
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', aweme_id: work.aweme_id,
  })
  const response = await c.ev(`${pageRequestSource}('GET', ${JSON.stringify(detailUrl)})`)
  let detail
  try { const j = JSON.parse(response.body); if (j.status_code === 0) detail = j.aweme_detail } catch { /* 明确类型仍可使用 */ }
  if (detail && String(detail.aweme_id) === work.aweme_id && detail.aweme_type != null) {
    work = parseWork(work.aweme_id, loaded.work_url, detail.aweme_type)
  } else {
    work = { ...work, route: loaded.route, work_url: loaded.work_url }
  }
  if (work.aweme_type === null && work.route === 'video') work.aweme_type = 0
  return work
}

export async function openCommentsPanel(c, { timeoutMs = 15000 } = {}) {
  const isOpen = () => c.ev(`(() => [...document.querySelectorAll('[data-e2e="comment-list"], [data-e2e="comment-item"]')].some(e => {
    const r=e.getBoundingClientRect();return r.width>0 && r.height>0
  }))()`)
  if (await isOpen()) return
  const deadline = Date.now() + timeoutMs
  let clicked = false
  do {
    if (await isOpen()) return
    if (!clicked) {
      const point = await c.ev(`(() => {
        const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}
        const tab = [...document.querySelectorAll('div,span,button')].find(e => visible(e) && /^评论[（(][0-9万.]+[）)]$/.test((e.innerText || '').replace(/\\s/g,'')))
        const icon = [...document.querySelectorAll('[data-e2e="feed-comment-icon"], [data-e2e="comment-icon"]')].find(visible)
        const button = tab || icon
        if(!button)return null
        button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}
      })()`)
      if(point){
        await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1})
        await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1})
        clicked=true
      }
    }
    await sleep(500)
  } while (Date.now() < deadline)
  throw new Error('作品已加载，但评论面板未就绪；未发送')
}

export async function scrollComments(c, delta = 600) {
  return c.ev(`(() => {
    const list=[...document.querySelectorAll('[data-e2e="comment-list"]')].find(e=>e.getBoundingClientRect().width>0)
    if(!list)return false
    for(let e=list;e&&e!==document.body;e=e.parentElement){
      if(e.scrollHeight>e.clientHeight+4&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)){
        e.scrollTop+=${Number(delta)};return true
      }
    }
    return false
  })()`)
}
