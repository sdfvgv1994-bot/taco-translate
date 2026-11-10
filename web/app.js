/* 對譯 app：畫面與操作。規則都在 core.js。 */
(function () {
  'use strict';
  var Core = window.Core;
  var K_SET = 'taco-translate:v1:settings';
  var K_HIST = 'taco-translate:v1:history';
  var K_PH = 'taco-translate:v1:phrases';
  var DEBOUNCE_MS = 800;

  function $(id) { return document.getElementById(id); }
  function load(key) {
    try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  var settings = Core.cleanSettings(load(K_SET));
  var history = Core.cleanHistory(load(K_HIST));
  var phrases = Core.cleanPhrases(load(K_PH));
  var armedPhrase = null;
  var cache = new Map();
  var seq = 0, aborter = null, timer = null;
  var current = null;        // 畫面上這句譯文對應的紀錄 { id, from, to, src, dst }
  var draftId = null;        // 打字途中自動存的那一筆
  var favOnly = false, armedId = null, armedClear = false, armedForget = false;
  var toastTimer = null;

  var el = {
    src: $('srcText'), dst: $('dstText'), status: $('status'), count: $('count'),
    from: $('selFrom'), to: $('selTo'), tag: $('providerTag'),
    mic: $('btnMic'), speak: $('btnSpeak'), copy: $('btnCopy'), fav: $('btnFav'), favLabel: $('favLabel'), big: $('btnBig'),
    bigBox: $('big'), bigText: $('bigText'), toast: $('toast'),
    list: $('histList'), q: $('histQ'), chipAll: $('chipAll'), chipFav: $('chipFav'),
    azKey: $('azKey'), azRegion: $('azRegion'), setMsg: $('setMsg'), providerNow: $('providerNow'),
    check: $('btnCheck'), cmpBox: $('cmpBox'), cmpBody: $('cmpBody'), selProvider: $('selProvider'),
    phTo: $('phTo'), phIn: $('phIn'), phMsg: $('phMsg'), phList: $('phList'),
    histInfo: $('histInfo'), clearHist: $('btnClearHist'), forget: $('btnForget'), speechInfo: $('speechInfo')
  };

  /* ---------- 小工具 ---------- */
  function toast(msg) {
    el.toast.textContent = msg; el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }
  function setStatus(msg, isErr) {
    el.status.textContent = msg || '';
    el.status.className = 'status' + (isErr ? ' err' : '');
  }
  function saveHistory() {
    if (!save(K_HIST, history)) toast('紀錄存不進去（瀏覽器的儲存空間滿了或被關掉）');
  }
  function saveSettings() { return save(K_SET, settings); }
  function newId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

  /* ---------- 語言 ---------- */
  function fillSelect(sel, value) {
    sel.textContent = '';
    Core.LANGS.forEach(function (l) {
      var o = document.createElement('option');
      o.value = l.id; o.textContent = l.name; sel.appendChild(o);
    });
    sel.value = value;
  }
  function onPairChange(changed) {
    var f = el.from.value, t = el.to.value;
    if (f === t) {                       // 選到一樣的：另一邊自動換成原本這邊的
      if (changed === 'from') { t = settings.from; el.to.value = t; }
      else { f = settings.to; el.from.value = f; }
    }
    settings.from = f; settings.to = t; saveSettings();
    draftId = null; stopMic();
    translateNow();
  }
  function swap() {
    stopMic();
    var oldDst = current && current.src === Core.normalizeText(el.src.value) ? current.dst : '';
    var f = settings.from; settings.from = settings.to; settings.to = f;
    el.from.value = settings.from; el.to.value = settings.to; saveSettings();
    if (oldDst) { el.src.value = oldDst; updateCount(); }
    draftId = null;
    translateNow();
  }

  /* ---------- 翻譯 ---------- */
  function updateCount() {
    el.count.textContent = Core.countChars(el.src.value) + ' 字';
  }
  function showResult(entry) {
    current = entry;
    el.dst.textContent = entry ? entry.dst : '';
    var has = !!entry;
    el.speak.disabled = el.copy.disabled = el.fav.disabled = el.big.disabled = el.check.disabled = !has;
    var item = has ? Core.findItem(history, entry.id) : null;
    var fav = !!(item && item.fav);
    el.fav.setAttribute('aria-pressed', fav ? 'true' : 'false');
    el.favLabel.textContent = fav ? '已收藏' : '收藏';
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(translateNow, DEBOUNCE_MS);
  }
  function translateNow() {
    clearTimeout(timer);
    if (aborter) { try { aborter.abort(); } catch (e) {} aborter = null; }
    var my = ++seq;
    var text = Core.normalizeText(el.src.value);
    var from = settings.from, to = settings.to;
    if (!text) { showResult(null); setStatus(''); draftId = null; return; }
    var provider = Core.pickProvider(settings);
    var bad = Core.checkInput(provider, text, from, to);
    if (bad) { showResult(null); setStatus(bad, true); return; }

    var key = Core.cacheKey(provider, from, to, text);
    if (cache.has(key)) { done(cache.get(key)); return; }
    var saved = history.filter(function (e) { return e.from === from && e.to === to && e.src === text; })[0];
    if (navigator.onLine === false) {
      if (saved) { done(saved.dst); setStatus('沒有網路，顯示的是之前翻過的結果'); }
      else { showResult(null); setStatus('現在沒有網路，連上之後再試。', true); }
      return;
    }

    var req;
    try { req = Core.buildRequest(provider, text, from, to, settings); }
    catch (e) { showResult(null); setStatus(e.message, true); return; }
    setStatus('翻譯中…');
    aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (aborter) req.options.signal = aborter.signal;
    var status = 0;
    fetch(req.url, req.options).then(function (res) {
      status = res.status;
      return res.json().catch(function () { return null; });
    }).then(function (json) {
      if (my !== seq) return;
      var out = Core.parseResponse(provider, status, json);
      cache.set(key, out);
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      done(out);
    }).catch(function (e) {
      if (my !== seq || (e && e.name === 'AbortError')) return;
      var msg = e && e.name === 'TypeError' ? '連不上翻譯服務，檢查一下網路再試。' : (e && e.message) || '翻譯失敗，再試一次。';
      if (saved) { done(saved.dst); setStatus(msg + '（先顯示之前翻過的結果）', true); }
      else { showResult(null); setStatus(msg, true); }
    });

    function done(out) {
      var r = Core.addHistory(history, { id: newId(), from: from, to: to, src: text, dst: out, at: Date.now() }, { replaceId: draftId });
      history = r.list; draftId = r.draft ? r.id : null; saveHistory();
      setStatus('');
      showResult({ id: r.id, from: from, to: to, src: text, dst: r.dst });
    }
  }

  /* ---------- 語音 ---------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, listening = false;
  function setMic(on) {
    listening = on;
    el.mic.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.mic.setAttribute('aria-label', on ? '正在收音，按一下停止' : '按一下開始說話');
  }
  function stopMic() {
    if (listening && rec) { try { rec.stop(); } catch (e) {} }
  }
  function toggleMic() {
    if (!SR) { toast('這個瀏覽器不支援語音輸入，請改用 Chrome 開'); return; }
    if (listening && rec) { stopMic(); return; }
    var base = el.src.value ? el.src.value.replace(/\s+$/, '') + ' ' : '';
    var before = el.src.value;
    try {
      rec = new SR();
      rec.lang = Core.langBy(settings.from).speech;
      rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
      rec.onresult = function (ev) {
        var s = '';
        for (var i = 0; i < ev.results.length; i++) {
          s += ev.results[i][0].transcript;
        }
        el.src.value = (base + s).slice(0, Core.MAX_LEN);
        updateCount();
      };
      rec.onerror = function (ev) {
        var m = { 'not-allowed': '麥克風沒有開放權限，到瀏覽器設定允許後再試', 'service-not-allowed': '麥克風沒有開放權限，到瀏覽器設定允許後再試',
          'no-speech': '沒聽到聲音，再按一次試試', 'audio-capture': '找不到麥克風', 'network': '語音辨識需要網路', 'language-not-supported': '這支手機的語音輸入不支援這個語言' }[ev.error];
        if (ev.error !== 'aborted') toast(m || '語音輸入失敗，再試一次');
      };
      rec.onend = function () {
        setMic(false); rec = null; el.src.readOnly = false;
        if (el.src.value !== before) translateNow();      // 只收到臨時結果也照翻
      };
      rec.start();
      el.src.readOnly = true;                             // 收音時先鎖住打字，免得手打的字被語音蓋掉
      setMic(true);
    } catch (e) { setMic(false); rec = null; el.src.readOnly = false; toast('語音輸入開不起來，再試一次'); }
  }
  function speak() {
    if (!current) return;
    draftId = null;                                       // 拿去用過就算定稿，之後打字不再改這筆
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') { toast('這個瀏覽器不支援朗讀'); return; }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(current.dst);
      u.lang = Core.langBy(current.to).speech;
      u.onerror = function (ev) { if (ev && ev.error !== 'canceled' && ev.error !== 'interrupted') toast('這支手機念不出這個語言'); };
      window.speechSynthesis.speak(u);
    } catch (e) { toast('朗讀失敗'); }
  }
  function copy() {
    if (!current) return;
    draftId = null;
    var text = current.dst;
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      toast(ok ? '已複製' : '複製失敗，請長按譯文自己複製');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已複製'); }, fallback);
    } else fallback();
  }
  function toggleCurrentFav() {
    if (!current) return;
    if (!Core.findItem(history, current.id)) {      // 紀錄被清掉了，先補回來
      var r = Core.addHistory(history, { id: current.id, from: current.from, to: current.to, src: current.src, dst: current.dst, at: Date.now() });
      history = r.list; current.id = r.id;
    }
    history = Core.toggleFav(history, current.id);
    if (draftId === current.id) draftId = null;     // 收藏過就不再當草稿改掉
    saveHistory(); showResult(current);
    if (!Core.findItem(history, current.id)) toast('收藏不進去，紀錄已經滿了');
  }
  /* 放大、檢查翻譯這兩個蓋在上面的畫面：Android 返回鍵只關掉它們，不會離開 app */
  var overlay = null, overlayPushed = false;
  function openOverlay(name) {
    overlay = name;
    (name === 'big' ? el.bigBox : el.cmpBox).hidden = false;
    try { window.history.pushState({ ov: name }, ''); overlayPushed = true; } catch (e) { overlayPushed = false; }
  }
  function closeOverlay(fromPop) {
    if (!overlay) return;
    var name = overlay; overlay = null;
    cmpSeq++;                                              // 還在跑的檢查請求不要再更新畫面、也不要再打下一個
    if (cmpAbort) { try { cmpAbort.abort(); } catch (e) {} cmpAbort = null; }
    el.bigBox.hidden = true; el.cmpBox.hidden = true;
    if (!fromPop && overlayPushed) { try { window.history.back(); } catch (e) {} }
    overlayPushed = false;
    var back = name === 'big' ? el.big : el.check;
    if (!back.disabled) back.focus();
  }
  function openBig() {
    if (!current || overlay) return;
    draftId = null;
    var n = Core.countChars(current.dst);
    el.bigText.className = 'big-text' + (n > 120 ? ' xlong' : n > 40 ? ' long' : '');
    el.bigText.textContent = current.dst; openOverlay('big'); el.bigBox.focus();
  }
  function closeBig() { closeOverlay(false); }

  /* ---------- 檢查翻譯：翻回原文、換另一家再翻 ---------- */
  var cmpSeq = 0, cmpAbort = null, inflight = new Map();
  function translateVia(provider, text, from, to, signal) {
    var bad = Core.checkInput(provider, text, from, to);
    if (bad) return Promise.reject(new Error(bad));
    var key = Core.cacheKey(provider, from, to, text);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (navigator.onLine === false) return Promise.reject(new Error('現在沒有網路。'));
    if (inflight.has(key)) return inflight.get(key);          // 同一句同時只打一次，連點不會多耗額度
    var req;
    try { req = Core.buildRequest(provider, text, from, to, settings); } catch (e) { return Promise.reject(e); }
    if (signal) req.options.signal = signal;
    var status = 0;
    var pr = fetch(req.url, req.options).then(function (res) {
      status = res.status; return res.json().catch(function () { return null; });
    }).then(function (json) {
      var out = Core.parseResponse(provider, status, json);
      cache.set(key, out);
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      inflight.delete(key);
      return out;
    }, function (e) { inflight.delete(key); throw e; });
    inflight.set(key, pr);
    return pr;
  }
  function errText(e, provider) {
    var m = e && e.name === 'TypeError' ? '連不上翻譯服務。' : (e && e.message) || '失敗了。';
    if (/Azure 金鑰才能翻/.test(m) && provider === 'mymemory') return 'MyMemory 不支援這個語言，沒辦法比。';
    if (/MyMemory 一次只能/.test(m)) return '句子太長，MyMemory 沒辦法處理這一句。';
    return m;
  }
  function sameText(x, y) {
    function n(s) { return Core.normalizeText(s).toLowerCase().replace(/[\s.,!?;:。，！？；：、"'「」『』（）()]/g, ''); }
    return n(x) === n(y);
  }
  function node(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n;
  }
  function cmpRow(title, fromName, toName) {
    var box = node('div', 'cmp');
    box.appendChild(node('h3', '', title));
    box.appendChild(node('div', 'lb', '翻成' + toName));
    var dst = node('p', 'tx', '翻譯中…'); dst.dir = 'auto'; box.appendChild(dst);
    box.appendChild(node('div', 'lb', '翻回' + fromName + '，檢查意思有沒有歪'));
    var back = node('p', 'tx back', '…'); back.dir = 'auto'; box.appendChild(back);
    function put(n, text, isErr) { n.textContent = text; n.className = 'tx' + (n === back ? ' back' : '') + (isErr ? ' err' : ''); }
    return { root: box, setDst: function (t, e) { put(dst, t, e); }, setBack: function (t, e) { put(back, t, e); } };
  }
  function openCheck() {
    if (!current || overlay) return;
    if (Core.normalizeText(el.src.value) !== current.src) { toast('原文改過了，等譯文跑完再檢查'); return; }
    draftId = null;
    cmpAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var sig = cmpAbort ? cmpAbort.signal : undefined;
    var c = { from: current.from, to: current.to, src: current.src, dst: current.dst };
    var my = ++cmpSeq;
    var p = Core.pickProvider(settings), o = Core.otherProvider(settings, p);
    var fromName = Core.langBy(c.from).name, toName = Core.langBy(c.to).name;
    el.cmpBody.textContent = '';
    var note = node('p', 'cmp-note', '');
    var rowA = cmpRow('目前：' + Core.providerName(p), fromName, toName);
    el.cmpBody.appendChild(rowA.root);
    rowA.setDst(c.dst, false);
    var results = {};
    function maybeNote() {
      if (results.a == null || results.b == null) return;
      note.textContent = sameText(results.a, results.b) ? '兩家翻出來的一樣，比較有把握。' : '兩家翻出來不一樣，重要的話請對照上面「翻回去」的意思，或找人確認。';
    }
    results.a = c.dst;
    translateVia(p, c.dst, c.to, c.from, sig).then(function (t) { if (my === cmpSeq) rowA.setBack(t, false); },
      function (e) { if (my === cmpSeq) rowA.setBack(errText(e, p), true); });
    if (o) {
      var rowB = cmpRow('另一家：' + Core.providerName(o), fromName, toName);
      el.cmpBody.appendChild(rowB.root);
      translateVia(o, c.src, c.from, c.to, sig).then(function (t2) {
        if (my !== cmpSeq) return;
        rowB.setDst(t2, false); results.b = t2; maybeNote();
        return translateVia(o, t2, c.to, c.from, sig).then(function (t3) { if (my === cmpSeq) rowB.setBack(t3, false); });
      }).catch(function (e) {
        if (my !== cmpSeq) return;
        if (results.b == null) { rowB.setDst(errText(e, o), true); rowB.setBack('—', false); } else rowB.setBack(errText(e, o), true);
      });
    } else {
      el.cmpBody.appendChild(node('p', 'p muted', '想看另一家的翻法，到「設定」填 Azure 金鑰（免費版就好）。'));
    }
    el.cmpBody.appendChild(note);
    openOverlay('cmp');
    $('btnCmpClose').focus();
  }

  /* ---------- 常用句 ---------- */
  function savePhrases() { if (!save(K_PH, phrases)) toast('常用句存不進去'); }
  function fillPhTo() {
    el.phTo.textContent = '';
    Core.LANGS.forEach(function (l) {
      if (l.id === 'zh') return;
      var o = document.createElement('option'); o.value = l.id; o.textContent = l.name; el.phTo.appendChild(o);
    });
  }
  function renderPhrases() {
    el.phTo.value = settings.to === 'zh' ? 'en' : settings.to;
    el.phList.textContent = '';
    if (!phrases.length) { el.phList.appendChild(node('p', 'empty', '沒有常用句了。上面可以新增。')); return; }
    phrases.forEach(function (t) {
      var row = node('div', 'item');
      var main = node('button', 'item-main'); main.type = 'button'; main.dataset.act = 'use'; main.dataset.t = t;
      var s = node('span', 'item-src', t); s.dir = 'auto'; main.appendChild(s);
      var del = node('button', ''); del.type = 'button'; del.dataset.act = 'del'; del.dataset.t = t;
      if (armedPhrase === t) { del.className = 'item-btn armed'; del.textContent = '確定刪除'; }
      else { del.className = 'item-btn'; del.innerHTML = TRASH; del.setAttribute('aria-label', '刪除這句'); }
      row.appendChild(main); row.appendChild(del); el.phList.appendChild(row);
    });
  }
  function onPhraseClick(ev) {
    var b = ev.target.closest('[data-act]'); if (!b) return;
    var t = b.dataset.t;
    if (b.dataset.act === 'use') {
      armedPhrase = null; stopMic();
      settings.from = 'zh'; if (settings.to === 'zh') settings.to = 'en';
      saveSettings(); el.from.value = settings.from; el.to.value = settings.to;
      el.src.value = t; updateCount(); draftId = null;
      showView('viewTranslate'); translateNow();
    } else if (b.dataset.act === 'del') {
      if (armedPhrase !== t) { armedPhrase = t; renderPhrases(); return; }
      armedPhrase = null; phrases = Core.removePhrase(phrases, t); savePhrases(); renderPhrases();
    }
  }
  function addPhrase() {
    var r = Core.addPhrase(phrases, el.phIn.value);
    el.phMsg.textContent = r.error;
    if (r.error) return;
    phrases = r.list; savePhrases(); el.phIn.value = ''; renderPhrases();
  }

  /* ---------- 紀錄 ---------- */
  var STAR = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l2.5 5.2 5.5.8-4 4 1 5.6-5-2.8-5 2.8 1-5.6-4-4 5.5-.8L12 4z"/></svg>';
  var TRASH = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M10 7V4h4v3"/><path d="M7 7l1 13h8l1-13"/></svg>';
  function div(cls, text) { var d = document.createElement('span'); d.className = cls; d.dir = 'auto'; d.textContent = text; return d; }
  function renderHistory() {
    var shown = Core.filterHistory(history, { q: el.q.value, favOnly: favOnly });
    el.chipAll.setAttribute('aria-pressed', favOnly ? 'false' : 'true');
    el.chipFav.setAttribute('aria-pressed', favOnly ? 'true' : 'false');
    el.list.textContent = '';
    if (!shown.length) {
      var p = document.createElement('p'); p.className = 'empty';
      p.textContent = history.length ? (favOnly && !el.q.value ? '還沒有收藏。在譯文下面按「收藏」就會出現在這裡。' : '找不到符合的紀錄。') : '還沒有紀錄。翻過的句子會自動出現在這裡。';
      el.list.appendChild(p); return;
    }
    shown.forEach(function (e) {
      var row = document.createElement('div'); row.className = 'item';
      var main = document.createElement('button'); main.type = 'button'; main.className = 'item-main';
      main.dataset.act = 'open'; main.dataset.id = e.id;
      main.appendChild(div('item-pair', Core.langBy(e.from).name + ' → ' + Core.langBy(e.to).name));
      main.appendChild(div('item-src', e.src));
      main.appendChild(div('item-dst', e.dst));
      var star = document.createElement('button'); star.type = 'button'; star.className = 'item-btn';
      star.dataset.act = 'fav'; star.dataset.id = e.id; star.innerHTML = STAR;
      star.setAttribute('aria-pressed', e.fav ? 'true' : 'false');
      star.setAttribute('aria-label', e.fav ? '取消收藏' : '加入收藏');
      var del = document.createElement('button'); del.type = 'button'; del.dataset.act = 'del'; del.dataset.id = e.id;
      if (armedId === e.id) { del.className = 'item-btn armed'; del.textContent = '確定刪除'; }
      else { del.className = 'item-btn'; del.innerHTML = TRASH; del.setAttribute('aria-label', '刪除這筆紀錄'); }
      row.appendChild(main); row.appendChild(star); row.appendChild(del);
      el.list.appendChild(row);
    });
  }
  function onListClick(ev) {
    var b = ev.target.closest('[data-act]'); if (!b) return;
    var id = b.dataset.id, item = Core.findItem(history, id); if (!item) return;
    if (b.dataset.act === 'open') {
      armedId = null;
      settings.from = item.from; settings.to = item.to; saveSettings();
      el.from.value = item.from; el.to.value = item.to;
      el.src.value = item.src; updateCount();
      clearTimeout(timer); seq++; draftId = null;
      setStatus(''); showResult({ id: item.id, from: item.from, to: item.to, src: item.src, dst: item.dst });
      showView('viewTranslate');
    } else if (b.dataset.act === 'fav') {
      armedId = null;
      history = Core.toggleFav(history, id); saveHistory();
      if (draftId === id) draftId = null;
      if (current && current.id === id) showResult(current);
      renderHistory();
    } else if (b.dataset.act === 'del') {
      if (armedId !== id) { armedId = id; renderHistory(); return; }
      armedId = null;
      history = Core.removeItem(history, id); saveHistory();
      if (draftId === id) draftId = null;
      if (current && current.id === id) showResult(current);
      renderHistory();
    }
  }

  /* ---------- 設定 ---------- */
  function setMsg(msg, isErr) { el.setMsg.textContent = msg || ''; el.setMsg.className = 'p' + (isErr ? ' err' : ''); }
  function renderSettings() {
    var p = Core.pickProvider(settings);
    el.tag.textContent = Core.providerName(p);
    var wantAzure = settings.provider === 'azure' && !settings.azureKey;
    el.providerNow.textContent = '目前使用：' + Core.providerName(p) +
      (wantAzure ? '（你選了 Azure，但還沒填金鑰，先用 MyMemory）' : p === 'azure' ? '（已填金鑰）' : settings.provider === 'mymemory' ? '（固定）' : '（還沒填 Azure 金鑰）');
    el.selProvider.value = settings.provider;
    el.forget.textContent = armedForget ? '再按一次確定移除' : '移除金鑰';
    el.forget.className = 'btn' + (armedForget ? ' armed' : '');
    var favs = history.filter(function (e) { return e.fav; }).length;
    el.histInfo.textContent = '共 ' + history.length + ' 筆紀錄，其中 ' + favs + ' 筆收藏。最多留 ' + Core.HISTORY_MAX + ' 筆，滿了會從最舊、沒收藏的開始丟。';
    el.clearHist.textContent = armedClear ? '再按一次確定清除' : '清除紀錄（收藏的會留著）';
    el.clearHist.className = 'btn' + (armedClear ? ' armed' : '');
    el.speechInfo.textContent = '語音輸入：' + (SR ? '這個瀏覽器可以用' : '這個瀏覽器不支援，請改用 Chrome') +
      '。朗讀：' + ('speechSynthesis' in window ? '可以用' : '不支援') + '。';
  }
  function fillForm() { el.azKey.value = settings.azureKey; el.azRegion.value = settings.azureRegion; }
  function formSettings() {
    return Core.cleanSettings({ azureKey: el.azKey.value, azureRegion: el.azRegion.value, provider: settings.provider, from: settings.from, to: settings.to });
  }
  function saveForm() {
    var next = formSettings(), bad = Core.keyProblem(next.azureKey);
    if (bad) { setMsg(bad, true); return; }
    settings = next; cache.clear(); armedForget = false;
    var ok = saveSettings(); fillForm(); renderSettings();
    if (el.src.value) translateNow();                      // 換了翻譯來源，畫面上的結果跟著重翻
    setMsg(ok ? (settings.azureKey ? '已儲存，之後用 Azure 翻譯。' : '已儲存。沒有金鑰，用 MyMemory 翻譯。') : '存不進去，手機瀏覽器可能關掉了儲存功能。', !ok);
  }
  function testForm() {
    var s = formSettings();
    if (!s.azureKey) { setMsg('先貼上金鑰再測試。', true); return; }
    if (Core.keyProblem(s.azureKey)) { setMsg(Core.keyProblem(s.azureKey), true); return; }
    if (navigator.onLine === false) { setMsg('現在沒有網路。', true); return; }
    setMsg('測試中…');
    var req = Core.buildRequest('azure', '你好', 'zh', 'en', s), status = 0;
    fetch(req.url, req.options).then(function (res) { status = res.status; return res.json().catch(function () { return null; }); })
      .then(function (json) { setMsg('連線成功：「你好」→「' + Core.parseResponse('azure', status, json) + '」。記得按「儲存」。'); })
      .catch(function (e) { setMsg(e && e.name === 'TypeError' ? '連不上 Azure，檢查網路或地區有沒有填對。' : (e && e.message) || '測試失敗。', true); });
  }
  function forgetKey() {
    if (!settings.azureKey && !el.azKey.value) { setMsg('目前沒有存金鑰。'); return; }
    if (!armedForget) { armedForget = true; renderSettings(); return; }
    armedForget = false;
    settings.azureKey = ''; settings.azureRegion = ''; cache.clear();
    saveSettings(); fillForm(); renderSettings(); setMsg('金鑰已從這支手機移除，改用 MyMemory。');
    if (el.src.value) translateNow();
  }
  function clearHist() {
    if (!armedClear) { armedClear = true; renderSettings(); return; }
    armedClear = false; history = Core.clearNonFav(history); draftId = null; saveHistory();
    if (current) showResult(current);
    renderSettings(); toast('已清除，收藏的還在');
  }

  /* ---------- 切換畫面 ---------- */
  function showView(id) {
    ['viewTranslate', 'viewPhrases', 'viewHistory', 'viewSettings'].forEach(function (v) { $(v).hidden = v !== id; });
    Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (b) {
      if (b.dataset.view === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    armedId = null; armedClear = false; armedForget = false; armedPhrase = null;
    if (id !== 'viewTranslate') stopMic();
    if (id === 'viewPhrases') { el.phMsg.textContent = ''; renderPhrases(); }
    if (id === 'viewHistory') renderHistory();
    if (id === 'viewSettings') {
      var dirty = el.azKey.value.trim() !== settings.azureKey || Core.cleanSettings({ azureRegion: el.azRegion.value }).azureRegion !== settings.azureRegion;
      setMsg(dirty ? '金鑰或地區改過但還沒存，記得按「儲存」。' : '', dirty);
      renderSettings();
    }
  }

  /* ---------- 開機 ---------- */
  fillSelect(el.from, settings.from); fillSelect(el.to, settings.to); fillPhTo();
  el.src.addEventListener('input', function () { updateCount(); schedule(); });
  el.from.addEventListener('change', function () { onPairChange('from'); });
  el.to.addEventListener('change', function () { onPairChange('to'); });
  $('btnSwap').addEventListener('click', swap);
  $('btnClear').addEventListener('click', function () { el.src.value = ''; updateCount(); translateNow(); el.src.focus(); });
  el.mic.addEventListener('click', toggleMic);
  el.speak.addEventListener('click', speak);
  el.copy.addEventListener('click', copy);
  el.fav.addEventListener('click', toggleCurrentFav);
  el.big.addEventListener('click', openBig);
  el.bigBox.addEventListener('click', closeBig);
  el.check.addEventListener('click', openCheck);
  $('btnCmpClose').addEventListener('click', function () { closeOverlay(false); });
  window.addEventListener('popstate', function (ev) {
    if (overlay && !(ev.state && ev.state.ov)) closeOverlay(true);
  });
  el.selProvider.addEventListener('change', function () {
    settings.provider = el.selProvider.value; saveSettings(); renderSettings();
    if (el.src.value) translateNow();
  });
  el.phList.addEventListener('click', onPhraseClick);
  $('btnPhAdd').addEventListener('click', addPhrase);
  el.phIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addPhrase(); } });
  el.phTo.addEventListener('change', function () {
    settings.to = el.phTo.value;
    if (settings.from === settings.to) { settings.from = 'zh'; el.from.value = 'zh'; }
    saveSettings(); el.to.value = settings.to;
  });
  el.list.addEventListener('click', onListClick);
  el.q.addEventListener('input', function () { armedId = null; renderHistory(); });
  el.chipAll.addEventListener('click', function () { favOnly = false; armedId = null; renderHistory(); });
  el.chipFav.addEventListener('click', function () { favOnly = true; armedId = null; renderHistory(); });
  $('btnSave').addEventListener('click', saveForm);
  $('btnTest').addEventListener('click', testForm);
  el.forget.addEventListener('click', forgetKey);
  el.clearHist.addEventListener('click', clearHist);
  Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (b) {
    b.addEventListener('click', function () { showView(b.dataset.view); });
  });
  window.addEventListener('online', function () { if (el.src.value && !current) translateNow(); });
  updateCount(); showResult(null); fillForm(); renderSettings();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () {});   // 讓沒網路時也打得開
  }
})();
