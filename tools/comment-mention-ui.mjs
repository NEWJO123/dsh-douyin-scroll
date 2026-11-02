#!/usr/bin/env node
/**
 * tools/comment-mention-ui.mjs —— 用**真实 UI 流程**在评论区 @ 人（唯一能保住 sec_uid 的路）
 * ============================================================================
 * 2026-10-21 实验定论：API/XHR 直发的 mention，服务端会把 sec_uid 剥掉 ⇒ 名字会蓝、
 * 但点开是空页、对方收不到通知。只有前端「点选 @ 弹层里的那一行」时，编辑器内存里有
 * 完整用户对象，服务端才信这个来源、保住 sec_uid。
 *
 * 已跑通的流程（2026-10-21 实测，使用者收到通知）：
 *   ① 视频页 → #comment-input-container 滚进视口中心 → 真实鼠标点开
 *   ② 点 .public-DraftEditor-content 聚焦
 *   ③ CDP 键盘事件打「@」（execCommand 不触发弹层）
 *   ④ 等弹层，按昵称找到叶子节点（最窄那个）→ 真实鼠标点选
 *   ⑤ execCommand 补正文
 *   ⑥ 点输入容器右下角的红色箭头 svg（fill=FE2C55）发布
 *
 * 用法:
 *   node tools/comment-mention-ui.mjs --aweme <id> --name <昵称> --text "正文" [--dry]
 *
 * --dry：点选完人 + 补完正文就停，不发布；会 dump 弹层行数据和编辑器 HTML。
 */
import { openPage, sleep } from '../lib/chrome.mjs'
import { prepareWorkPage, openCommentsPanel } from '../lib/douyin-work.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const DRY = argv.includes('--dry')
const AWEME = String(argOf('--aweme', '')).trim()
const WORK_URL = String(argOf('--url', '')).trim()
const AWEME_TYPE = String(argOf('--aweme-type', '')).trim()
const NAME = String(argOf('--name', '')).trim()
const TEXT = String(argOf('--text', '')).trim()
/**
 * ⭐ `--reply-cid <cid>`：回复**某一条**评论（而不是发顶层）。
 *    2026-10-22 加 —— 用户要"回评论区 @ 我的人"，那本质是"回复某条评论 + @ 他"。
 *    实现：先把那条评论滚进视口 → 点它下面的「回复」→ 再走原来的 @ 点选流程。
 *    点了「回复」之后，评论输入框的语义就是"回复那条"，前端会自动带上 reply 关系。
 */
const REPLY_CID = String(argOf('--reply-cid', '')).trim()
/**
 * ⭐ `--reply-text <片段>`：按**评论正文片段**定位要回复的那条（比 cid 稳）。
 *    🔴 2026-10-23 实测：cid 只活在 React fiber 的深层 props 里，抖音改版后
 *    遍历 fiber 找不到（还会撞循环引用）⇒ 干脆用**页面上看得见的文字**定位，
 *    这才是人找评论的方式。取第一条包含该片段的评论节点。
 */
const REPLY_TEXT = String(argOf('--reply-text', '')).trim()

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok === false ? 1 : 0 }
const DOM_HELPERS = `var visible=function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0};`

if (!AWEME || !NAME) { out({ ok: false, error: '用法: comment-mention-ui.mjs --aweme <id> --name <昵称> [--text 正文] [--reply-cid <cid> | --reply-text <片段>] [--dry]' }); process.exit(1) }

let c
try {
  c = await openPage({ isolated: true })
  const chromed = c.status

  const mv = (x, y) => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  const click = async (x, y) => {
    await mv(x, y); await sleep(150)
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  const scrollComments = async () => {
    const point = await c.ev(`(function(){ ${DOM_HELPERS}
      ${DOM_HELPERS}
      var list=[].slice.call(document.querySelectorAll('[data-e2e="comment-list"], [class*="commentList"], [class*="comment-list"]')).find(visible);
      if(!list)return null;
      var r=list.getBoundingClientRect();return {x:Math.min(innerWidth-2,Math.max(1,r.x+r.width/2)),y:Math.min(innerHeight-100,Math.max(100,r.y+100))};
    })()`)
    if(!point) throw new Error('找不到可见评论列表，未滚动视频区域')
    await c.send('Input.dispatchMouseEvent', {type:'mouseWheel',...point,deltaX:0,deltaY:800})
  }

  const work = await prepareWorkPage(c, { aweme: AWEME, work_url: WORK_URL, aweme_type: AWEME_TYPE })
  await openCommentsPanel(c)

  /**
   * ⭐ 如果要"回复某条评论"：先把那条评论滚进视口，点它下面的「回复」。
   *    点了之后输入框的语义就变成"回复这条"，前端会自己带 reply 关系。
   *    ⚠️ 找不到就**中止**，别默默改成发顶层（用户要的是回复）。
   */
  let replyInfo = null
  if (REPLY_CID || REPLY_TEXT) {
    // 先把评论区滚出来
    try {
      await c.ev(`(function(){ ${DOM_HELPERS}
        var el = [].slice.call(document.querySelectorAll('[data-e2e="comment-list"]')).find(visible);
        if (el) el.scrollIntoView({block:'center'});
      })()`)
      await sleep(1500)
    } catch { /* 滚不动就继续 */ }

    /**
     * ⭐⭐ 按**正文片段**找目标评论（2026-10-23 加，首选路径）。
     *    人找评论就是这么找的：页面上有那行字 → 滚到它 → 点它下面的「回复」。
     *    不碰 React fiber，所以不会撞循环引用、也不怕抖音改 fiber 结构。
     */
    if (REPLY_TEXT) {
      let hit = ''
      for (let i = 0; i < 12 && !hit; i++) {
        hit = String(await c.ev(`(function(){ ${DOM_HELPERS}
          var NEEDLE = ${JSON.stringify(REPLY_TEXT)};
          var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-item"]')).filter(visible);
          var matches=nodes.filter(function(n){return (n.innerText||'').indexOf(NEEDLE)>=0});
          matches=matches.filter(function(n){return !matches.some(function(o){return o!==n&&n.contains(o)})});
          if(matches.length>1) throw new Error('正文片段匹配多条评论，请提供更完整的片段');
          for (var i = 0; i < matches.length; i++) {
            var n = matches[i];
            var t = (n.innerText || '');
            if (t.indexOf(NEEDLE) < 0) continue;
            n.scrollIntoView({ block: 'center' });
            var r = n.getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          }
          return '';
        })()`))
        if (!hit) {
          await scrollComments()
          await sleep(1400)
        }
      }
      if (!hit) {
        out({ ok: false, error: `评论区里找不到含「${REPLY_TEXT}」的那条评论（滚了 12 屏）`, code: 'reply_target_not_found' })
        throw { __done: true }
      }
      // 找到节点后，在它里面点「回复」
      const rb0 = String(await c.ev(`(function(){ ${DOM_HELPERS}
        var NEEDLE = ${JSON.stringify(REPLY_TEXT)};
        var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-item"]')).filter(visible);
        var matches=nodes.filter(function(n){return (n.innerText||'').indexOf(NEEDLE)>=0});
        matches=matches.filter(function(n){return !matches.some(function(o){return o!==n&&n.contains(o)})});
        if(matches.length!==1)throw new Error('目标评论消失或出现歧义，已停止');
        for (var i = 0; i < matches.length; i++) {
          var n = matches[i];
          var cands = Array.prototype.slice.call(n.querySelectorAll('span,div,button,a'));
          for (var j = 0; j < cands.length; j++) {
            var e = cands[j];
            if (!visible(e) || e.children.length) continue;
            if ((e.innerText || '').trim() !== '回复') continue;
            var r = e.getBoundingClientRect();
            if (!(r.width > 4 && r.height > 8)) continue;
            return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          }
        }
        return '';
      })()`))
      if (rb0) {
        const rb = JSON.parse(rb0)
        await click(rb.x, rb.y)
        await sleep(1800)
        replyInfo = { reply_by_text: REPLY_TEXT, reply_button: rb }
      } else {
        out({ ok: false, error: `找到「${REPLY_TEXT}」那条评论了，但没找到它下面的「回复」按钮`, code: 'reply_button_not_found' })
        throw { __done: true }
      }
    }

    if (!replyInfo && REPLY_CID) {
      let found = ''
      for (let i = 0; i < 10 && !found; i++) {
        found = String(await c.ev(`(function(){ ${DOM_HELPERS}
          var CID = ${JSON.stringify(REPLY_CID)};
          if(!CID) return '';
          // 评论节点通常带 data-e2e="comment-item" 或 cid 在 fiber 里
          var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-item"]')).filter(visible);
          var matches=[];
          for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
            var hit = false;
            if (fk) {
              var f = n[fk], d = 0;
              while (f && d < 16) {
                var p = f.memoizedProps;
                if (p && typeof p === 'object') {
                  /**
                   * 🔴 2026-10-23 实测 bug：直接 JSON.stringify(memoizedProps) 会**抛异常** ——
                   *    React fiber 的 props 有循环引用（children 指回 fiber），
                   *    stringify 抛 "Converting circular structure to JSON"，
                   *    整段 evaluate Uncaught ⇒ 找 reply-cid 永远失败（工具只报"页面里抛错"）。
                   * ✅ 改成：只扫**浅层字段**的字符串/数字值（cid 就在这一层），整段 try/catch。
                   */
                  try {
                    for (var k in p) {
                      var v = p[k];
                      if (typeof v === 'string' && v === CID) { hit = true; break }
                      if (typeof v === 'number' && String(v) === CID) { hit = true; break }
                      if (v && typeof v === 'object' && !v.children) {
                        for (var k2 in v) {
                          var v2 = v[k2];
                          if (typeof v2 === 'string' && v2 === CID) { hit = true; break }
                          if (typeof v2 === 'number' && String(v2) === CID) { hit = true; break }
                        }
                        if (hit) break;
                      }
                    }
                  } catch (e) { /* 这一层读不动就跳过 */ }
                  if (hit) break;
                }
                f = f.return; d++;
              }
            }
            // 兜底：节点自身或父级文本里带 cid（少见，但有些版本会渲染到属性）
            if (!hit && (n.getAttribute && String(n.getAttribute('data-cid') || '') === CID)) hit = true;
            if (!hit) continue;
            matches.push(n);
          }
          if(matches.length>1) throw new Error('cid 匹配多条评论，停止以避免回复错误目标');
          if(!matches.length) return '';
          var n=matches[0];
          n.setAttribute('data-dsh-reply-target',CID);
          n.scrollIntoView({ block: 'center' });
          var r=n.getBoundingClientRect();
          return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
        })()`))
        if (!found) {
          // 往下滚一屏再找
          await scrollComments()
          await sleep(1500)
        }
      }
      if (!found) {
        out({ ok: false, error: `评论区里找不到 cid=${REPLY_CID} 这条评论（可能被删了 / 或者滚得不够深）`, code: 'reply_target_not_found' })
        throw { __done: true }
      }

      // 在那条评论里找「回复」按钮并点它
      const replyBtn = String(await c.ev(`(function(){ ${DOM_HELPERS}
        var CID = ${JSON.stringify(REPLY_CID)};
          if(!CID) return '';
        var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-item"]')).filter(visible);
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if(n.getAttribute('data-dsh-reply-target')!==CID) continue;
          // 在该节点范围内找文字是「回复」的可点元素
          var cands = Array.prototype.slice.call(n.querySelectorAll('span,div,button,a'));
          for (var j = 0; j < cands.length; j++) {
            var e = cands[j];
            if (!visible(e) || e.children.length) continue;
            if ((e.innerText || '').trim() !== '回复') continue;
            var r = e.getBoundingClientRect();
            if (!(r.width > 4 && r.height > 8)) continue;
            return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          }
        }
        return '';
      })()`))
      if (!replyBtn) {
        out({ ok: false, error: '找到了那条评论，但没找到「回复」按钮', code: 'reply_button_not_found' })
        throw { __done: true }
      }
      const rb = JSON.parse(replyBtn)
      await click(rb.x, rb.y)
      await sleep(1800)
      replyInfo = { reply_to_cid: REPLY_CID, reply_button: rb }
    }
  }

  // ① 使用当前可见编辑器；尚未展开时点评论占位文字。
  const box = JSON.parse(await c.ev(`(function(){ ${DOM_HELPERS}
    var e=[].slice.call(document.querySelectorAll('.public-DraftEditor-content')).find(visible);
    if(!e)e=[].slice.call(document.querySelectorAll('span,div,p')).find(function(n){return visible(n)&&!n.children.length&&(n.innerText||'').trim()==='留下你的精彩评论吧'});
    if(!e) return '{}';
    e.scrollIntoView({block:'center'});
    var r=e.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
  })()`))
  if (!box.x) { out({ ok: false, error: '找不到可见评论编辑器或占位文字' }); throw { __done: true } }
  await click(box.x, box.y)
  await sleep(1500)

  // ② 点 DraftJS 编辑器聚焦
  const ed = JSON.parse(await c.ev(`(function(){ ${DOM_HELPERS}
    var e=[].slice.call(document.querySelectorAll('.public-DraftEditor-content')).find(visible);
    if(!e) return '{}';
    e.scrollIntoView({block:'center'});
    var r=e.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
  })()`))
  if (!ed.x) { out({ ok: false, error: '评论编辑器没展开（.public-DraftEditor-content 不存在）' }); throw { __done: true } }
  await click(ed.x, ed.y)
  await sleep(400)

  // ③ 打 @（必须键盘事件；execCommand 不会触发弹层）
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '@', key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 })
  await sleep(1800)

  // ④ 找弹层里昵称那一行（叶子节点、最窄的），把 fiber 里的用户数据一起 dump
  const row = JSON.parse(await c.ev(`(function(){ ${DOM_HELPERS}
    var NAME=${JSON.stringify(NAME)}; var rows=[];
    document.querySelectorAll('div,span,li,p').forEach(function(e){
      if (!visible(e) || e.children.length) return;
      if ((e.innerText||'').trim()!==NAME) return;
      var r=e.getBoundingClientRect();
      if (!(r.width>4 && r.height>8)) return;
      var fk=Object.keys(e).find(function(k){return k.indexOf('__reactFiber$')===0});
      var ids=[];
      if (fk){ var f=e[fk],d=0;
        while(f&&d<14){ var p=f.memoizedProps;
          if(p&&typeof p==='object'){
            for(var k in p){ var v=p[k];
              if(typeof v==='string'&&/^\\d{10,20}$/.test(v)) ids.push(k+'='+v);
              else if(typeof v==='string'&&/^(MS4wLjABAA|11-\\d{6,})/.test(v)) ids.push(k+'='+String(v).slice(0,34));
              else if(v&&typeof v==='object'){ if(v.uid)ids.push('obj.uid='+v.uid); if(v.sec_uid)ids.push('obj.sec_uid='+String(v.sec_uid).slice(0,30)); }
            }
          }
          f=f.return; d++;
        }
      }
      var uniq=[]; ids.forEach(function(x){ if(uniq.indexOf(x)<0) uniq.push(x); });
      rows.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),ids:uniq.slice(0,8)});
    });
    rows.sort(function(a,b){ return a.w-b.w; });
    return JSON.stringify(rows[0]||{});
  })()`))
  if (!row.x) { out({ ok: false, error: '@ 弹层里没找到这个名字（可能没互关 / 昵称不对）' }); throw { __done: true } }

  // 真实鼠标点选那一行
  await click(row.x, row.y)
  await sleep(1000)

  /**
   * ⑤ 补正文。
   * 🔴 2026-10-22 实测 bug：点选 mention 后，编辑器里**已经有** `@昵称` 这个 token 了。
   *    如果 TEXT 本身又以 `@昵称` 开头（调用方要求"正文里必须原样出现 @昵称"），
   *    直接插入整段 TEXT 就会变成 `@示例好友 @示例好友 正文` —— **重复一次**。
   *    ⇒ 先看编辑器现在是什么，把 TEXT 开头那个 `@昵称` 去掉再插。
   */
  if (TEXT) {
    let body = String(TEXT)
    // 去掉开头的 @昵称（含可能跟着的空格）
    const lead = '@' + NAME
    if (body.startsWith(lead)) body = body.slice(lead.length).replace(/^[\s\u3000]+/, '')
    // 再看编辑器里到底有没有 @昵称（不同版本可能不自动插入，保险起见按实际判断）
    const hasToken = await c.ev(`(function(){ ${DOM_HELPERS}
      var e=[].slice.call(document.querySelectorAll('.public-DraftEditor-content')).find(visible);
      return e ? String(e.innerText||'').indexOf(${JSON.stringify(lead)}) >= 0 : false;
    })()`)
    if (body) {
      await c.ev(`document.execCommand('insertText', false, ${JSON.stringify(' ' + body)})`)
      await sleep(600)
    }
    // 如果真的没自动插入 mention，就把 @昵称 补回去（否则名字不会蓝）
    if (!hasToken) {
      await c.ev(`document.execCommand('insertText', false, ${JSON.stringify(lead + ' ')})`)
      await sleep(400)
    }
  }

  const editorHtml = await c.ev(`(function(){ ${DOM_HELPERS}
    var e=[].slice.call(document.querySelectorAll('.public-DraftEditor-content')).find(visible);
    return e ? String(e.innerHTML||'').slice(0,900) : '';
  })()`)

  if (DRY) {
    out({ ok: true, dry: true, aweme_id: work.aweme_id, work_url: work.work_url, aweme_type: work.aweme_type, popup_row: row, editor_html: editorHtml, chrome: chromed })
    throw { __done: true }
  }

  // ⑥ 点右下角红色箭头发布（svg 里 fill=FE2C55，往上找到 ≥24px 的可点容器）
  const btn = JSON.parse(await c.ev(`(function(){ ${DOM_HELPERS}
    var editor=[].slice.call(document.querySelectorAll('.public-DraftEditor-content')).find(visible);
    if(!editor)return '{}';
    var er=editor.getBoundingClientRect();
    for(var root=editor.parentElement,d=0;root&&d<8;root=root.parentElement,d++){
      var svgs=[].slice.call(root.querySelectorAll('svg')).filter(function(e){var r=e.getBoundingClientRect();return visible(e)&&/fe2c55/i.test(e.innerHTML||'')&&r.y>=er.y-10&&r.x>=er.x});
      svgs.sort(function(a,b){return Math.abs(a.getBoundingClientRect().y-er.bottom)-Math.abs(b.getBoundingClientRect().y-er.bottom)});
      if(!svgs.length)continue;
      for (var e=svgs[0],up=0; up<4 && e; up++,e=e.parentElement){
        var r=e.getBoundingClientRect();
        if (visible(e)&&r.width>=24&&r.height>=24) {e.scrollIntoView({block:'center'});r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}
      }
    }
    return '{}';
  })()`))
  if (!btn.x) { out({ ok: false, error: '找不到发布箭头', editor_html: editorHtml }); throw { __done: true } }
  await click(btn.x, btn.y)
  await sleep(4000)

  const editorAfter = await c.ev(`(function(){ ${DOM_HELPERS}  var e=[].slice.call(document.querySelectorAll('.public-DraftEditor-content')).find(visible); return e ? String(e.innerText||'').slice(0,60) : '(gone)'; })()`)
  out({ ok: true, published: true, aweme_id: work.aweme_id, work_url: work.work_url, aweme_type: work.aweme_type, mention: NAME, ...(replyInfo || {}), popup_row: row, editor_html: editorHtml, editor_after: editorAfter, chrome: chromed })
} catch (e) {
  if (!(e && e.__done)) out({ ok: false, error: String(e?.message ?? e) })
} finally {
  if (c) await c.close()
}
