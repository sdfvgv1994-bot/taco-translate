/* 對譯 core：純規則，不碰畫面。瀏覽器掛在 window.Core，node 測試用 require。 */
(function (root) {
  'use strict';

  var MAX_LEN = 1000;          // App 自己的上限（字元）
  var MM_MAX_BYTES = 500;      // MyMemory 一次最多 500 bytes
  var HISTORY_MAX = 200;

  // id 是 App 內部代號；azure / mm / speech 是各服務用的語言代碼
  var LANGS = [
    { id: 'zh', name: '中文（繁體）', azure: 'zh-Hant', mm: 'zh-TW', speech: 'zh-TW' },
    { id: 'en', name: '英文', azure: 'en', mm: 'en', speech: 'en-US' },
    { id: 'ja', name: '日文', azure: 'ja', mm: 'ja', speech: 'ja-JP' },
    { id: 'ko', name: '韓文', azure: 'ko', mm: 'ko', speech: 'ko-KR' },
    { id: 'vi', name: '越南文', azure: 'vi', mm: 'vi', speech: 'vi-VN' },
    { id: 'th', name: '泰文', azure: 'th', mm: 'th', speech: 'th-TH' },
    { id: 'id', name: '印尼文', azure: 'id', mm: 'id', speech: 'id-ID' },
    { id: 'fr', name: '法文', azure: 'fr', mm: 'fr', speech: 'fr-FR' },
    { id: 'de', name: '德文', azure: 'de', mm: 'de', speech: 'de-DE' },
    { id: 'es', name: '西班牙文', azure: 'es', mm: 'es', speech: 'es-ES' },
    { id: 'zhs', name: '中文（簡體）', azure: 'zh-Hans', mm: 'zh-CN', speech: 'zh-CN' },
    { id: 'yue', name: '粵語', azure: 'yue', mm: null, speech: 'zh-HK' },      // mm: null = MyMemory 不支援，只能用 Azure
    { id: 'fil', name: '菲律賓文', azure: 'fil', mm: 'tl', speech: 'fil-PH' },
    { id: 'my', name: '緬甸文', azure: 'my', mm: 'my', speech: 'my-MM' },
    { id: 'ms', name: '馬來文', azure: 'ms', mm: 'ms', speech: 'ms-MY' },
    { id: 'hi', name: '印地文', azure: 'hi', mm: 'hi', speech: 'hi-IN' },
    { id: 'ar', name: '阿拉伯文', azure: 'ar', mm: 'ar', speech: 'ar-SA' },
    { id: 'ru', name: '俄文', azure: 'ru', mm: 'ru', speech: 'ru-RU' },
    { id: 'it', name: '義大利文', azure: 'it', mm: 'it', speech: 'it-IT' },
    { id: 'pt', name: '葡萄牙文', azure: 'pt', mm: 'pt', speech: 'pt-BR' }
  ];

  function langBy(id) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].id === id) return LANGS[i];
    return null;
  }

  function normalizeText(s) {
    return String(s == null ? '' : s)
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')            // 落單的半個 emoji 丟掉，不然組網址會出錯
      .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
      .replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  }

  function countChars(s) {
    return Array.from(String(s == null ? '' : s)).length;
  }

  function byteLength(s) {
    var n = 0, str = String(s);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* 注音還沒選字（ㄅ～ㄩ）：這時候翻出來一定是錯的，先不要送 */
  function hasBopomofo(s) {
    return /[\u3105-\u312F]/.test(String(s == null ? '' : s));
  }

  /* 金鑰只能是一般英數符號；貼到中文或全形字會讓請求整個送不出去 */
  function keyProblem(key) {
    if (!key) return '';
    return /^[\x21-\x7e]+$/.test(key) ? '' : '金鑰裡有中文、全形字或空白，請重新從 Azure 複製一次。';
  }

  function cleanSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    var from = langBy(s.from) ? s.from : 'zh';
    var to = langBy(s.to) ? s.to : 'en';
    if (from === to) to = from === 'en' ? 'zh' : 'en';
    return {
      azureKey: typeof s.azureKey === 'string' ? s.azureKey.trim() : '',
      azureRegion: typeof s.azureRegion === 'string' ? s.azureRegion.trim().toLowerCase().replace(/\s+/g, '') : '',
      from: from,
      to: to
    };
  }

  function pickProvider(settings) {
    return settings && settings.azureKey ? 'azure' : 'mymemory';
  }

  function providerName(p) {
    return p === 'azure' ? 'Azure' : 'MyMemory';
  }

  /* 送出前檢查；沒問題回傳 ''，有問題回傳要給使用者看的話 */
  function checkInput(provider, text, from, to) {
    if (!text) return '';
    if (!langBy(from) || !langBy(to)) return '語言設定怪怪的，請重新選一次語言。';
    if (from === to) return '兩邊選了一樣的語言，換一個才能翻。';
    if (from === 'zh' && hasBopomofo(text)) return '注音還沒選字，選好字就會翻。';
    if (provider === 'mymemory' && (!langBy(from).mm || !langBy(to).mm)) {
      return '「' + (!langBy(from).mm ? langBy(from).name : langBy(to).name) + '」要先到「設定」填 Azure 金鑰才能翻。';
    }
    if (countChars(text) > MAX_LEN) return '太長了，一次最多 ' + MAX_LEN + ' 個字。';
    if (provider === 'mymemory' && byteLength(text) > MM_MAX_BYTES) {
      return 'MyMemory 一次只能翻很短的句子（中文大約 160 個字）。請縮短一點，或到「設定」填 Azure 金鑰。';
    }
    return '';
  }

  function buildRequest(provider, text, from, to, settings) {
    var f = langBy(from), t = langBy(to);
    if (!f || !t) throw new Error('語言設定怪怪的，請重新選一次語言。');
    if (provider === 'azure') {
      var headers = {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': settings.azureKey
      };
      if (settings.azureRegion) headers['Ocp-Apim-Subscription-Region'] = settings.azureRegion;
      return {
        url: 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0' +
          '&from=' + encodeURIComponent(f.azure) + '&to=' + encodeURIComponent(t.azure),
        options: { method: 'POST', headers: headers, body: JSON.stringify([{ Text: text }]) }
      };
    }
    if (!f.mm || !t.mm) throw new Error('這個語言 MyMemory 不支援，請到「設定」填 Azure 金鑰。');
    return {
      url: 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
        '&langpair=' + encodeURIComponent(f.mm + '|' + t.mm),
      options: { method: 'GET' }
    };
  }

  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, e) {
      e = e.toLowerCase();
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      var code = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (err) { return m; }
    });
  }

  /* 把服務回的東西變成譯文；有問題就丟出中文錯誤訊息 */
  function parseResponse(provider, status, json) {
    if (provider === 'azure') {
      if (status >= 200 && status < 300 && Array.isArray(json) && json[0] &&
          Array.isArray(json[0].translations) && json[0].translations[0] &&
          typeof json[0].translations[0].text === 'string') {
        return json[0].translations[0].text;
      }
      var code = json && json.error && json.error.code;
      if (status === 401 || (code >= 401000 && code < 402000)) {
        throw new Error('Azure 金鑰不對，或「地區」沒填對。請到「設定」檢查。');
      }
      if (code === 403001) throw new Error('Azure 這個月的免費額度用完了，下個月會恢復。');
      if (status === 403 || (code >= 403000 && code < 404000)) {
        throw new Error('Azure 不允許這個操作（代碼 ' + (code || status) + '），請到「設定」檢查金鑰和地區。');
      }
      if (status === 429 || (code >= 429000 && code < 430000)) {
        throw new Error('翻太快了，等幾秒再試。');
      }
      if (status >= 500) throw new Error('Azure 那邊暫時有問題，等一下再試。');
      throw new Error('Azure 沒有回傳譯文（代碼 ' + (code || status) + '）。');
    }
    var rs = json ? Number(json.responseStatus) : NaN;
    var text = json && json.responseData && json.responseData.translatedText;
    var warn = typeof text === 'string' && /^MYMEMORY WARNING/i.test(text);
    if (status === 429 || rs === 429 || warn) {
      throw new Error('MyMemory 今天的免費額度用完了，明天會恢復；或到「設定」填 Azure 金鑰。');
    }
    if (status >= 200 && status < 300 && rs === 200 && typeof text === 'string' && text) {
      return decodeEntities(text);
    }
    if (status >= 500) throw new Error('MyMemory 那邊暫時有問題，等一下再試。');
    throw new Error('MyMemory 沒有回傳譯文（代碼 ' + (isFinite(rs) ? rs : status) + '）。');
  }

  function cacheKey(provider, from, to, text) {
    return provider + '\n' + from + '\n' + to + '\n' + text;
  }

  /* ---------- 紀錄 ---------- */

  function cleanHistory(list) {
    if (!Array.isArray(list)) return [];
    var out = [], seen = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object') continue;
      if (typeof e.id !== 'string' || !e.id || seen[e.id]) continue;
      if (!langBy(e.from) || !langBy(e.to)) continue;
      if (typeof e.src !== 'string' || typeof e.dst !== 'string' || !e.src) continue;
      seen[e.id] = true;
      out.push({ id: e.id, from: e.from, to: e.to, src: e.src, dst: e.dst, fav: e.fav === true, at: Number(e.at) || 0 });
    }
    return out;
  }

  function trimHistory(list, max) {
    max = max || HISTORY_MAX;
    var out = list.slice();
    for (var i = out.length - 1; i >= 1 && out.length > max; i--) {
      if (!out[i].fav) out.splice(i, 1);     // 從最舊的開始丟；收藏的不丟，最上面剛加的那筆也不丟
    }
    return out;
  }

  /*
   * 加一筆到最上面。回傳 { list, id, dst, draft }。
   * - 同語言、同原文已經有：搬到最上面，收藏狀態留著；收藏過的連譯文也留著（那是使用者挑過的）。
   *   這種不算草稿（draft: false），之後繼續打字不會去改它。
   * - replaceId：上一筆是「打字打到一半」自動存的，而且新原文是它的延伸，就直接改那一筆，
   *   不要每停一下就多一筆。只認「變長」，刪字縮短一律另存，寧可多一筆也不吃掉翻好的句子。收藏過的不會被改。
   */
  function addHistory(list, entry, opts) {
    opts = opts || {};
    var out = list.slice(), i;
    for (i = 0; i < out.length; i++) {
      if (out[i].from === entry.from && out[i].to === entry.to && out[i].src === entry.src) {
        var same = out.splice(i, 1)[0];
        var kept = { id: same.id, from: same.from, to: same.to, src: same.src, dst: same.fav ? same.dst : entry.dst, fav: same.fav, at: entry.at };
        if (opts.replaceId && opts.replaceId !== same.id) {
          out = out.filter(function (d) { return !(d.id === opts.replaceId && isDraftOf(d, entry)); });
        }
        out.unshift(kept);
        return { list: trimHistory(out, opts.max), id: kept.id, dst: kept.dst, draft: false };
      }
    }
    if (opts.replaceId) {
      for (i = 0; i < out.length; i++) {
        var d = out[i];
        if (d.id === opts.replaceId && isDraftOf(d, entry)) {
          out.splice(i, 1);
          out.unshift({ id: d.id, from: entry.from, to: entry.to, src: entry.src, dst: entry.dst, fav: false, at: entry.at });
          return { list: trimHistory(out, opts.max), id: d.id, dst: entry.dst, draft: true };
        }
      }
    }
    out.unshift({ id: entry.id, from: entry.from, to: entry.to, src: entry.src, dst: entry.dst, fav: false, at: entry.at });
    return { list: trimHistory(out, opts.max), id: entry.id, dst: entry.dst, draft: true };
  }

  function isDraftOf(d, entry) {
    return !d.fav && d.from === entry.from && d.to === entry.to &&
      entry.src.length > d.src.length && entry.src.indexOf(d.src) === 0;
  }

  function toggleFav(list, id) {
    return list.map(function (e) {
      return e.id === id ? { id: e.id, from: e.from, to: e.to, src: e.src, dst: e.dst, fav: !e.fav, at: e.at } : e;
    });
  }

  function removeItem(list, id) {
    return list.filter(function (e) { return e.id !== id; });
  }

  function clearNonFav(list) {
    return list.filter(function (e) { return e.fav; });
  }

  function findItem(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function filterHistory(list, opts) {
    opts = opts || {};
    var q = normalizeText(opts.q || '').toLowerCase();
    return list.filter(function (e) {
      if (opts.favOnly && !e.fav) return false;
      if (!q) return true;
      return e.src.toLowerCase().indexOf(q) !== -1 || e.dst.toLowerCase().indexOf(q) !== -1;
    });
  }

  var Core = {
    MAX_LEN: MAX_LEN, MM_MAX_BYTES: MM_MAX_BYTES, HISTORY_MAX: HISTORY_MAX, LANGS: LANGS,
    langBy: langBy, normalizeText: normalizeText, countChars: countChars, byteLength: byteLength, hasBopomofo: hasBopomofo, keyProblem: keyProblem,
    cleanSettings: cleanSettings, pickProvider: pickProvider, providerName: providerName,
    checkInput: checkInput, buildRequest: buildRequest, parseResponse: parseResponse,
    decodeEntities: decodeEntities, cacheKey: cacheKey,
    cleanHistory: cleanHistory, addHistory: addHistory, toggleFav: toggleFav, removeItem: removeItem,
    clearNonFav: clearNonFav, findItem: findItem, filterHistory: filterHistory
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : this);
