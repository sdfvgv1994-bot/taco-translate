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

  /* Vision 端點只收 https://名稱.cognitiveservices.azure.com：金鑰只會送到 Azure，不會被填成別的網址帶走 */
  function normalizeEndpoint(v) {
    var s = typeof v === 'string' ? v.trim() : '';
    var m = /^https:\/\/([a-z0-9][a-z0-9-]*)\.cognitiveservices\.azure\.com\/*$/i.exec(s);
    return m ? 'https://' + m[1].toLowerCase() + '.cognitiveservices.azure.com' : '';
  }

  function endpointProblem(v) {
    var s = typeof v === 'string' ? v.trim() : '';
    if (!s) return '';
    return normalizeEndpoint(s) ? '' : '端點要像 https://名稱.cognitiveservices.azure.com/ 這樣，請從 Azure 的「金鑰與端點」那頁複製。';
  }

  function cleanSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    var from = langBy(s.from) ? s.from : 'zh';
    var to = langBy(s.to) ? s.to : 'en';
    if (from === to) to = from === 'en' ? 'zh' : 'en';
    return {
      azureKey: typeof s.azureKey === 'string' ? s.azureKey.trim() : '',
      azureRegion: typeof s.azureRegion === 'string' ? s.azureRegion.trim().toLowerCase().replace(/\s+/g, '') : '',
      visionKey: typeof s.visionKey === 'string' ? s.visionKey.trim() : '',
      visionEndpoint: normalizeEndpoint(s.visionEndpoint),
      provider: s.provider === 'mymemory' || s.provider === 'azure' ? s.provider : 'auto',
      from: from,
      to: to
    };
  }

  /* 自動：有金鑰用 Azure，沒有用 MyMemory。選 Azure 但沒金鑰時，暫時退回 MyMemory（設定頁會提醒）。 */
  function pickProvider(settings) {
    if (settings && settings.provider === 'mymemory') return 'mymemory';
    return settings && settings.azureKey ? 'azure' : 'mymemory';
  }

  /* 另一家；沒有金鑰就沒有 Azure 可比，回傳 '' */
  function otherProvider(settings, provider) {
    if (provider === 'azure') return 'mymemory';
    return settings && settings.azureKey ? 'azure' : '';
  }

  /* ---------- 常用句（中文原句，點一下填進原文去翻） ---------- */
  var PHRASES_MAX = 30, PHRASE_LEN = 100;
  var DEFAULT_PHRASES = [
    '請問這個地址怎麼走？',
    '我到了，請問你在哪裡？',
    '請到一樓大門口拿餐，謝謝。',
    '我把餐放在門口了。',
    '請問是幾樓？',
    '請給我你的電話號碼，我打給你。',
    '不好意思，我找不到這個地址。',
    '請問這是你點的餐嗎？',
    '請給我一點時間，我馬上到。',
    '謝謝，祝你用餐愉快！'
  ];

  function cleanPhrases(list) {
    if (!Array.isArray(list)) return DEFAULT_PHRASES.slice();
    var out = [], seen = Object.create(null);
    for (var i = 0; i < list.length && out.length < PHRASES_MAX; i++) {
      var t = typeof list[i] === 'string' ? normalizeText(list[i]) : '';
      if (!t || countChars(t) > PHRASE_LEN || seen[t]) continue;
      seen[t] = true; out.push(t);
    }
    return out;
  }

  /* 加一句；回傳 { list, error }，error 有字就是沒加成 */
  function addPhrase(list, text) {
    var t = normalizeText(text);
    if (!t) return { list: list, error: '先打一句話。' };
    if (countChars(t) > PHRASE_LEN) return { list: list, error: '太長了，一句最多 ' + PHRASE_LEN + ' 個字。' };
    if (list.indexOf(t) >= 0) return { list: list, error: '這句已經有了。' };
    if (list.length >= PHRASES_MAX) return { list: list, error: '最多存 ' + PHRASES_MAX + ' 句，先刪掉一些。' };
    return { list: [t].concat(list), error: '' };
  }

  function removePhrase(list, text) {
    return list.filter(function (p) { return p !== text; });
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

  /* ---------- 照片翻譯：Azure Vision 讀出照片裡的字（Image Analysis 4.0 的 Read） ---------- */
  var PHOTO_MAX_SIDE = 2000;        // 送出前把照片縮到最長邊這麼大：省流量、省免費額度，字也還看得清楚

  function visionReady(settings) {
    return !!(settings && settings.visionKey && settings.visionEndpoint);
  }

  /* image 是照片的 Blob；回傳 { url, options }，用法跟 buildRequest 一樣 */
  function buildVisionRequest(image, settings) {
    if (!visionReady(settings)) throw new Error('照片辨識還沒設定，請到「設定」填 Vision 的金鑰和端點。');
    return {
      url: settings.visionEndpoint + '/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read',
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Ocp-Apim-Subscription-Key': settings.visionKey },
        body: image
      }
    };
  }

  /* 把 Vision 回的東西變成一段文字（一行一行用換行接起來）；有問題就丟出中文錯誤訊息 */
  function parseVisionResponse(status, json) {
    if (status >= 200 && status < 300) {
      var blocks = json && json.readResult && json.readResult.blocks;
      if (!Array.isArray(blocks)) throw new Error('照片辨識沒有回傳文字，再試一次。');
      var lines = [];
      blocks.forEach(function (b) {
        (b && Array.isArray(b.lines) ? b.lines : []).forEach(function (l) {
          var t = l && typeof l.text === 'string' ? l.text.trim() : '';
          if (t) lines.push(t);
        });
      });
      var text = normalizeText(lines.join('\n'));
      if (!text) throw new Error('照片裡沒有讀到文字。靠近一點、光線亮一點，把字拍清楚再試一次。');
      return text;
    }
    var err = json && json.error;
    var code = err && err.code ? String(err.code) : '';
    var inner = err && err.innererror && err.innererror.code ? String(err.innererror.code) : '';
    if (status === 401) throw new Error('照片辨識的金鑰不對，或端點沒填對。請到「設定」檢查。');
    if (status === 403) throw new Error('照片辨識不允許這個操作，或這個月的免費額度用完了。請到「設定」檢查，或下個月再試。');
    if (status === 404) throw new Error('找不到照片辨識的端點，請到「設定」檢查端點有沒有填對。');
    if (status === 429) throw new Error('照片辨識太頻繁，或這個月的免費額度用完了。等一下再試。');
    if (status === 400 && (inner === 'InvalidImageFormat' || /size|format/i.test(err && err.message || ''))) {
      throw new Error('這張照片的格式不支援，或檔案太大，換一張試試。');
    }
    if (status >= 500) throw new Error('Azure 照片辨識那邊暫時有問題，等一下再試。');
    throw new Error('照片辨識失敗（代碼 ' + (code || status) + '）。');
  }

  /* 照片尺寸：最長邊超過 max 就等比例縮小，不會放大 */
  function fitSize(w, h, max) {
    w = Number(w); h = Number(h); max = max || PHOTO_MAX_SIDE;
    if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
    var long = Math.max(w, h);
    if (long <= max) return { w: Math.round(w), h: Math.round(h) };
    var k = max / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  /* ---------- 照片是什麼語言：用 Azure 翻譯的 detect 認，認到就自動把語言對設好 ---------- */
  function langByAzure(code) {
    code = String(code || '').toLowerCase();
    if (code === 'pt-pt' || code === 'pt-br') code = 'pt';
    if (code === 'tl') code = 'fil';
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].azure.toLowerCase() === code) return LANGS[i];
    return null;
  }

  function buildDetectRequest(text, settings) {
    var headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': settings.azureKey };
    if (settings.azureRegion) headers['Ocp-Apim-Subscription-Region'] = settings.azureRegion;
    return {
      url: 'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0',
      options: { method: 'POST', headers: headers, body: JSON.stringify([{ Text: Array.from(String(text)).slice(0, 500).join('') }]) }
    };
  }

  /* 認不出來就回 ''（畫面照原本選的語言翻，不會壞） */
  function parseDetectResponse(status, json) {
    if (status >= 200 && status < 300 && Array.isArray(json) && json[0] && typeof json[0].language === 'string') return json[0].language;
    return '';
  }

  /*
   * 照片要從什麼翻成什麼。拍照多半是「看不懂的字 → 中文」：
   * - 照片是外文：外文 → 中文（繁體）
   * - 照片是繁體中文：中文 → 目前用的另一邊語言（兩邊都是中文就英文）
   * - 認不出來或不在 20 種裡面：照原本選的不動，known: false
   */
  function photoPair(detected, from, to) {
    var l = langByAzure(detected);
    if (!l) return { from: from, to: to, known: false };
    if (l.id !== 'zh') return { from: l.id, to: 'zh', known: true };
    var other = from !== 'zh' ? from : to !== 'zh' ? to : 'en';
    return { from: 'zh', to: other, known: true };
  }

  /* 照片讀出來的字太長就只留前面 max 個字，並告訴畫面有被截斷 */
  function limitText(text, max) {
    max = max || MAX_LEN;
    var chars = Array.from(String(text == null ? '' : text));
    if (chars.length <= max) return { text: chars.join(''), cut: false };
    return { text: chars.slice(0, max).join('').trim(), cut: true };
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
    langBy: langBy, otherProvider: otherProvider, DEFAULT_PHRASES: DEFAULT_PHRASES, PHRASES_MAX: PHRASES_MAX,
    cleanPhrases: cleanPhrases, addPhrase: addPhrase, removePhrase: removePhrase, normalizeText: normalizeText, countChars: countChars, byteLength: byteLength, hasBopomofo: hasBopomofo, keyProblem: keyProblem,
    cleanSettings: cleanSettings, pickProvider: pickProvider, providerName: providerName,
    checkInput: checkInput, buildRequest: buildRequest, parseResponse: parseResponse,
    decodeEntities: decodeEntities, cacheKey: cacheKey,
    PHOTO_MAX_SIDE: PHOTO_MAX_SIDE, normalizeEndpoint: normalizeEndpoint, endpointProblem: endpointProblem,
    visionReady: visionReady, buildVisionRequest: buildVisionRequest, parseVisionResponse: parseVisionResponse,
    fitSize: fitSize, limitText: limitText,
    langByAzure: langByAzure, buildDetectRequest: buildDetectRequest, parseDetectResponse: parseDetectResponse, photoPair: photoPair,
    cleanHistory: cleanHistory, addHistory: addHistory, toggleFav: toggleFav, removeItem: removeItem,
    clearNonFav: clearNonFav, findItem: findItem, filterHistory: filterHistory
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== 'undefined' ? window : this);
