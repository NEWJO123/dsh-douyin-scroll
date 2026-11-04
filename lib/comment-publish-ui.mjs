/** Publish through Douyin's native editor; inspect and gate its one outgoing request. */
import { sleep } from './chrome.mjs'
import { openCommentsPanel, pageRequestSource, scrollComments } from './douyin-work.mjs'

const publishUrl = (value) => {
  try { const u = new URL(value); return u.hostname === 'www.douyin.com' && /^\/aweme\/v1\/web\/comment\/publish\/?$/.test(u.pathname) } catch { return false }
}
const pointSource = `const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
  const point=e=>{e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}};`

async function click(c, p) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'none', buttons: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 })
}

// Only read requests here. Exact outgoing IDs are checked separately before release.
async function targetText(c, aweme, root, target) {
  const path = target === root ? '/aweme/v1/web/comment/list/' : '/aweme/v1/web/comment/list/reply/'
  let cursor = 0
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ aid: '6383', device_platform: 'webapp', channel:'channel_pc_web', pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
      cookie_enabled:'true',screen_width:'1920',screen_height:'1080',browser_language:'zh-CN',browser_platform:'Win32',browser_name:'Chrome',browser_version:'141.0.0.0',engine_name:'Blink',engine_version:'141.0.0.0',os_name:'Windows',os_version:'10',platform:'PC',
      ...(target === root ? {aweme_id:aweme} : {item_id:aweme,comment_id:root}), cursor: String(cursor), count: '20', item_type: '0' })
    const r = await c.ev(`${pageRequestSource}('GET', ${JSON.stringify(path + '?' + qs)})`)
    let j; try { j = JSON.parse(r.body) } catch { break }
    const hit = (j.comments || []).find(x => String(x.cid) === target)
    if (hit) return String(hit.text || '')
    if (!j.has_more || j.cursor == null || Number(j.cursor) === cursor) break
    cursor = Number(j.cursor)
  }
  return ''
}

/** Browser-only probe; collections and parent records never identify the current row. */
export function commentReplyCandidates({ target, text = '' }) {
  const visible = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const compact = (value) => String(value || '').replace(/\s/g, '')
  const ownId = (record) => {
    if (!record || typeof record !== 'object') return ''
    for (const key of ['cid', 'comment_id', 'commentId']) if (record[key] != null && !['', '0'].includes(String(record[key]))) return String(record[key])
    return ''
  }
  const nodes = [...document.querySelectorAll('[data-e2e="comment-item"]')].filter(visible)
  const identity = (node) => {
    const attribute = node.getAttribute('data-cid') || node.getAttribute('data-comment-id') || ''
    const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'))
    let fiber = key ? node[key] : null
    for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
      if (fiber.stateNode && fiber.stateNode !== node && nodes.includes(fiber.stateNode)) break
      const props = fiber.memoizedProps
      // Nearest commentInfo/replyInfo owns this row. Stop even for a different ID:
      // commentList and originCommentInfo can point at valid siblings or parents.
      const owned = [...new Set([ownId(props?.replyInfo), ownId(props?.commentInfo), ownId(props)].filter(Boolean))]
      if (owned.length) return { id: owned[0], ids: [...new Set([attribute, ...owned].filter(Boolean))], conflict: owned.length > 1 || Boolean(attribute && attribute !== owned[0]) }
    }
    return { id: attribute, ids: attribute ? [attribute] : [], conflict: false }
  }
  const rows = nodes.map((node) => ({ node, ...identity(node) }))
  if (rows.some((row) => row.conflict && row.ids.includes(target))) return { nodes, matches: [], error: '目标评论身份记录不一致，已停止' }
  const exact = rows.filter((row) => !row.conflict && row.id === target)
  if (exact.length) return { nodes, matches: exact.map((row) => row.node), matched_by: 'comment-id' }
  const matches = rows.filter((row) => !row.id && text && compact(row.node.innerText).includes(compact(text))).map((row) => row.node)
  return { nodes, matches, matched_by: 'unique-text' }
}

async function selectReply(c, { root, reply_to, target_text = '', root_text = '' }) {
  const target = reply_to || root
  if (!target) return
  const text = target_text
  let lastProbe = null
  for(let i=0;i<20;i++){
    if(await c.ev(`Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).some(e=>e.getBoundingClientRect().width>0)`))break
    await sleep(500)
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await c.ev(`(() => {
      ${pointSource}
      const target=${JSON.stringify(target)}, text=${JSON.stringify(text)};
      const probe=(${commentReplyCandidates.toString()})({target,text});
      if(probe.error)return {error:probe.error};
      const {nodes,matches,matched_by}=probe;
      const own=matches.filter(n=>!matches.some(other=>other!==n&&n.contains(other)));
      if(own.length>1&&matched_by!=='comment-id')return {error:'目标评论匹配多条可见记录，已停止'};
      if(!own.length){
        const rootText=${JSON.stringify(root_text)};
        if(rootText){
          const compact=s=>String(s||'').replace(/\\s/g,'');
          const roots=nodes.filter(n=>compact(n.innerText).includes(compact(rootText)));
          const ownRoots=roots.filter(n=>!roots.some(o=>o!==n&&n.contains(o)));
          if(ownRoots.length===1){
            const expand=[...ownRoots[0].querySelectorAll('div,span,button')].find(e=>visible(e)&&!e.children.length&&/^(展开.*回复|查看更多回复)/.test((e.innerText||'').trim()));
            if(expand)return {expand:point(expand)};
          }
        }
        const list=[...document.querySelectorAll('[data-e2e="comment-list"], [class*="commentList"], [class*="comment-list"]')].find(visible);
        if(!list)return {};
        const r=list.getBoundingClientRect();
        return {scroll:{x:Math.max(1,Math.min(innerWidth-2,r.x+r.width/2)),y:Math.min(innerHeight-100,Math.max(100,r.y+100))},visible_n:nodes.length};
      }
      const n=own[0];n.scrollIntoView({block:'center'});
      const buttons=[...n.querySelectorAll('span,div,button,a')].filter(e=>visible(e)&&!e.children.length&&(e.innerText||'').trim()==='回复');
      if(!buttons.length)return {error:'找到目标评论，但没有可见回复按钮'};
      return {button:point(buttons[0])};
    })()`)
    if (result.error) throw new Error(result.error)
    if (result.button) { await click(c, result.button); await sleep(600); return }
    if (result.expand) { await click(c,result.expand); await sleep(800); continue }
    if(result.visible_n===lastProbe?.visible_n)await scrollComments(c,-100)
    if (result.scroll) {
      await c.send('Input.dispatchMouseEvent', {type:'mouseMoved',...result.scroll,button:'none',buttons:0})
      await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...result.scroll, deltaX: 0, deltaY: 700 })
    }
    lastProbe = result
    await sleep(600)
  }
  throw new Error(`翻页后仍没有找到目标评论 ${target}；未发送`)
}

export async function publishComment(c, { aweme_id, root = '', reply_to = '', text, dry = false }) {
  aweme_id = String(aweme_id || ''); root = String(root || ''); reply_to = String(reply_to || ''); text = String(text || '')
  const result = { http: 0, cid: '', status_code: null, rt: '', rtt: '', lv: null, has_lv: false, attempted:false, transport: 'page-frontend' }
  if (!aweme_id || !text || (reply_to && !root)) return { ...result, error: '作品、正文或回复关系无效' }
  let resolveResult, finished = false, allowed = false, seen = 0, requestId = '', responseId = '', enabled = false
  const complete = new Promise(resolve => { resolveResult = resolve })
  const finish = (value) => { if (!finished) { finished = true; resolveResult({ ...result, ...value }) } }
  const unsub = []
  const fail = async (id) => { await c.send('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }) }
  try {
    await c.send('Network.enable')
    unsub.push(c.on('Fetch.requestPaused', async (event) => {
      if (!publishUrl(event.request.url)) { await fail(event.requestId); finish({ error: '发布请求地址不符合预期', blocked: true }); return }
      try {
        const body = new URLSearchParams(event.request.postData || '')
        const zero = v => !v || v === '0'
        const sameRoot = root ? body.get('reply_id') === root : zero(body.get('reply_id'))
        const sameReply = reply_to ? body.get('reply_to_reply_id') === reply_to : zero(body.get('reply_to_reply_id'))
        const valid = event.request.method === 'POST' && body.get('aweme_id') === aweme_id && body.get('text') === text && sameRoot && sameReply
        seen++
        if (!valid || dry || allowed || finished) {
          await fail(event.requestId)
          finish({ error: !valid ? '原生发布请求与目标作品、正文或回复关系不一致，已拦截' : dry ? undefined : '重复发布请求已拦截',
            dry, blocked: true, payload: { aweme_id: body.get('aweme_id'), text: body.get('text'), reply_id: body.get('reply_id'), reply_to_reply_id: body.get('reply_to_reply_id') } })
          return
        }
        allowed = true; result.attempted = true; requestId = event.networkId || ''
        await c.send('Fetch.continueRequest', { requestId: event.requestId })
      } catch (e) { await fail(event.requestId).catch(() => {}); finish({ error: String(e.message || e) }) }
    }))
    unsub.push(c.on('Network.responseReceived', e => {
      if (allowed && publishUrl(e.response.url) && (!requestId || e.requestId === requestId)) { responseId = e.requestId; result.http = e.response.status }
    }))
    unsub.push(c.on('Network.loadingFinished', async e => {
      if (!responseId || e.requestId !== responseId) return
      try {
        const r = await c.send('Network.getResponseBody', { requestId: e.requestId })
        const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
        let j; try { j = JSON.parse(body) } catch { finish({ error: '发布回包不是 JSON；结果未知，请勿重发', head: body.slice(0, 240) }); return }
        const comment = j.comment || {}
        const cid = comment.cid ? String(comment.cid) : ''
        finish({ status_code: j.status_code ?? null, cid, rt: String(comment.reply_id || ''), rtt: String(comment.reply_to_reply_id || ''),
          lv: comment.level ?? null, has_lv: comment.level != null,
          error: result.http === 200 && j.status_code === 0 && cid ? undefined : '未收到成功状态和 cid；结果未确认，请勿重发', head: body.slice(0, 240) })
      } catch (e) { finish({ error: '读取发布回包失败；结果未知，请勿重发：' + String(e.message || e) }) }
    }))
    unsub.push(c.on('Network.loadingFailed', e => {
      if (allowed && requestId && e.requestId === requestId) finish({ error: '发布请求失败；结果未知，请勿重发：' + e.errorText })
    }))
    // 评论分页依赖站点请求顺序；先读定位依据，再让原生评论列表独立分页。
    const target_text = root ? await targetText(c, aweme_id, root, reply_to || root) : ''
    const root_text = reply_to ? await targetText(c, aweme_id, root, root) : ''
    await openCommentsPanel(c)
    await selectReply(c, { root, reply_to, target_text, root_text })
    let editor = await c.ev(`(() => { ${pointSource} const e=[...document.querySelectorAll('.public-DraftEditor-content')].find(visible);return e?point(e):null })()`)
    if (!editor) {
      const placeholder = await c.ev(`(() => { ${pointSource} const e=[...document.querySelectorAll('span,div,p')].find(e=>visible(e)&&!e.children.length&&(e.innerText||'').trim()==='留下你的精彩评论吧');return e?point(e):null })()`)
      if (!placeholder) throw new Error('找不到可见评论编辑器或占位文字')
      await click(c, placeholder); await sleep(400)
      editor = await c.ev(`(() => { ${pointSource} const e=[...document.querySelectorAll('.public-DraftEditor-content')].find(visible);return e?point(e):null })()`)
    }
    if (!editor) throw new Error('评论编辑器未展开')
    await click(c, editor)
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await c.send('Input.insertText', { text }); await sleep(400)
    const arrow = await c.ev(`(() => {
      ${pointSource}
      const editor=[...document.querySelectorAll('.public-DraftEditor-content')].find(visible);if(!editor)return null;
      const er=editor.getBoundingClientRect();
      let scope=editor.parentElement;
      for(let d=0;scope&&d<8;d++,scope=scope.parentElement){
        const svgs=[...scope.querySelectorAll('svg')].filter(e=>visible(e)&&/fe2c55/i.test(e.innerHTML||''));
        const candidates=svgs.filter(e=>{const r=e.getBoundingClientRect();return r.y>=er.y-10&&r.x>=er.x});
        if(!candidates.length)continue;
        candidates.sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return Math.abs(ar.y-er.bottom)-Math.abs(br.y-er.bottom)});
        let e=candidates[0];for(let up=0;up<4&&e;up++,e=e.parentElement){const r=e.getBoundingClientRect();if(visible(e)&&r.width>=24&&r.height>=24)return point(e)}
      }
      return null;
    })()`)
    if (!arrow) throw new Error('找不到当前编辑器的可见发布箭头')
    await c.send('Fetch.enable', { patterns: [{ urlPattern: '*comment/publish*', requestStage: 'Request' }] }); enabled = true
    await click(c, arrow)
    let timer
    try { return await Promise.race([complete, new Promise(resolve => { timer = setTimeout(() => resolve({ ...result, error: seen ? '发布回包等待超时；结果未知，请勿重发' : '点击后没有捕获发布请求；未确认发布' }), 20000) })]) }
    finally { clearTimeout(timer) }
  } catch (e) { return { ...result, error: String(e.message || e) + (allowed ? '；发布结果未知，请勿重发' : '') } }
  finally {
    if (enabled) await c.send('Fetch.disable').catch(() => {})
    for (const off of unsub) off()
  }
}
