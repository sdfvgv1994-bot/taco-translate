'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../web/core.js');

const S = (o) => Core.cleanSettings(o);
const E = (id, src, dst, extra) => Object.assign({ id, from: 'zh', to: 'en', src, dst, at: 1 }, extra);

test('語言表：代號不重複，每個服務的代碼都有', () => {
  const ids = Core.LANGS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const l of Core.LANGS) {
    assert.ok(l.name && l.azure && l.speech, l.id);
    assert.ok(l.mm || l.id === 'yue', l.id);   // 只有粵語沒有 MyMemory 代碼
  }
  assert.equal(Core.LANGS.length, 20);
  assert.equal(new Set(Core.LANGS.map((l) => l.azure)).size, 20);
  assert.equal(Core.langBy('zh').azure, 'zh-Hant');
  assert.equal(Core.langBy('zh').mm, 'zh-TW');
  assert.equal(Core.langBy('xx'), null);
});

test('粵語：MyMemory 擋下並提示填 Azure；Azure 可以送', () => {
  assert.match(Core.checkInput('mymemory', '你好', 'zh', 'yue'), /Azure/);
  assert.match(Core.checkInput('mymemory', '你好', 'yue', 'en'), /粵語/);
  assert.equal(Core.checkInput('azure', '你好', 'zh', 'yue'), '');
  const req = Core.buildRequest('azure', '你好', 'zh', 'yue', { azureKey: 'k' });
  assert.match(req.url, /to=yue/);
});

test('簡體、新語言的請求代碼', () => {
  assert.throws(() => Core.buildRequest('mymemory', 'x', 'zh', 'yue', {}), /Azure/);
  const a = Core.buildRequest('azure', '你好', 'zh', 'zhs', { azureKey: 'k' });
  assert.match(a.url, /from=zh-Hant&to=zh-Hans/);
  const m = Core.buildRequest('mymemory', 'hi', 'en', 'fil', {});
  assert.match(m.url, /langpair=en%7Ctl/);
});

test('normalizeText / countChars / byteLength', () => {
  assert.equal(Core.normalizeText('  你好 \t 嗎  '), '你好 嗎');
  assert.equal(Core.normalizeText('a\r\nb'), 'a\nb');
  assert.equal(Core.normalizeText(null), '');
  assert.equal(Core.countChars('請問😀'), 3);
  assert.equal(Core.byteLength('abc'), 3);
  assert.equal(Core.byteLength('你好'), 6);
  assert.equal(Core.byteLength('é'), 2);
  assert.equal(Core.byteLength('😀'), 4);
  assert.equal(Core.byteLength('你好😀a'), Buffer.byteLength('你好😀a'));
});

test('cleanSettings：壞資料變成預設值', () => {
  assert.deepEqual(S(null), { azureKey: '', azureRegion: '', visionKey: '', visionEndpoint: '', provider: 'auto', from: 'zh', to: 'en' });
  assert.deepEqual(S({ azureKey: '  abc ', azureRegion: ' East Asia ', from: 'ja', to: 'xx' }),
    { azureKey: 'abc', azureRegion: 'eastasia', visionKey: '', visionEndpoint: '', provider: 'auto', from: 'ja', to: 'en' });
  assert.deepEqual(S({ azureKey: 123 }).azureKey, '');
});

test('pickProvider：有金鑰用 Azure，沒有用 MyMemory', () => {
  assert.equal(Core.pickProvider(S({})), 'mymemory');
  assert.equal(Core.pickProvider(S({ azureKey: 'k' })), 'azure');
  assert.equal(Core.pickProvider(S({ azureKey: '   ' })), 'mymemory');
});

test('checkInput', () => {
  assert.equal(Core.checkInput('azure', '', 'zh', 'en'), '');
  assert.equal(Core.checkInput('azure', '你好', 'zh', 'en'), '');
  assert.match(Core.checkInput('azure', '你好', 'zh', 'zh'), /一樣的語言/);
  assert.match(Core.checkInput('azure', '你好', 'zh', 'xx'), /語言設定/);
  assert.match(Core.checkInput('azure', '字'.repeat(1001), 'zh', 'en'), /太長/);
  assert.equal(Core.checkInput('azure', '字'.repeat(1000), 'zh', 'en'), '');
  assert.equal(Core.checkInput('mymemory', '字'.repeat(166), 'zh', 'en'), '');   // 498 bytes
  assert.match(Core.checkInput('mymemory', '字'.repeat(167), 'zh', 'en'), /MyMemory/); // 501 bytes
  assert.equal(Core.checkInput('azure', '字'.repeat(167), 'zh', 'en'), '');
});

test('buildRequest：Azure', () => {
  const r = Core.buildRequest('azure', '你好 & <b>', 'zh', 'en', S({ azureKey: 'KEY', azureRegion: 'eastasia' }));
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, 'https://api.cognitive.microsofttranslator.com/translate');
  assert.equal(u.searchParams.get('api-version'), '3.0');
  assert.equal(u.searchParams.get('from'), 'zh-Hant');
  assert.equal(u.searchParams.get('to'), 'en');
  assert.equal(r.options.method, 'POST');
  assert.equal(r.options.headers['Ocp-Apim-Subscription-Key'], 'KEY');
  assert.equal(r.options.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
  assert.deepEqual(JSON.parse(r.options.body), [{ Text: '你好 & <b>' }]);
  assert.ok(!r.url.includes('KEY'), '金鑰不可以出現在網址');
});

test('buildRequest：Azure 沒填地區就不送地區標頭', () => {
  const r = Core.buildRequest('azure', 'hi', 'en', 'zh', S({ azureKey: 'KEY' }));
  assert.ok(!('Ocp-Apim-Subscription-Region' in r.options.headers));
  assert.equal(new URL(r.url).searchParams.get('to'), 'zh-Hant');
});

test('buildRequest：MyMemory', () => {
  const r = Core.buildRequest('mymemory', '多少錢？&a=1', 'zh', 'ja', S({}));
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, 'https://api.mymemory.translated.net/get');
  assert.equal(u.searchParams.get('q'), '多少錢？&a=1');
  assert.equal(u.searchParams.get('langpair'), 'zh-TW|ja');
  assert.equal(r.options.method, 'GET');
  assert.throws(() => Core.buildRequest('mymemory', 'x', 'zh', 'xx', S({})), /語言設定/);
});

test('parseResponse：Azure', () => {
  assert.equal(Core.parseResponse('azure', 200, [{ translations: [{ text: 'Hello', to: 'en' }] }]), 'Hello');
  assert.throws(() => Core.parseResponse('azure', 401, { error: { code: 401000, message: 'x' } }), /金鑰不對/);
  assert.throws(() => Core.parseResponse('azure', 403, { error: { code: 403001, message: 'x' } }), /額度用完/);
  assert.throws(() => Core.parseResponse('azure', 429, { error: { code: 429000 } }), /太快/);
  assert.throws(() => Core.parseResponse('azure', 503, null), /暫時有問題/);
  assert.throws(() => Core.parseResponse('azure', 400, { error: { code: 400036 } }), /400036/);
  assert.throws(() => Core.parseResponse('azure', 200, null), /沒有回傳譯文/);
  assert.throws(() => Core.parseResponse('azure', 200, [{ translations: [] }]), /沒有回傳譯文/);
});

test('parseResponse：MyMemory', () => {
  const ok = (text, rs) => ({ responseData: { translatedText: text }, responseStatus: rs });
  assert.equal(Core.parseResponse('mymemory', 200, ok('Hello', 200)), 'Hello');
  assert.equal(Core.parseResponse('mymemory', 200, ok('It&#39;s &quot;ok&quot; &amp; fine', '200')), 'It\'s "ok" & fine');
  assert.throws(() => Core.parseResponse('mymemory', 200, ok('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY', 200)), /額度用完/);
  assert.throws(() => Core.parseResponse('mymemory', 429, ok('x', 429)), /額度用完/);
  assert.throws(() => Core.parseResponse('mymemory', 200, ok('INVALID LANGUAGE PAIR', 403)), /403/);
  assert.throws(() => Core.parseResponse('mymemory', 200, ok('', 200)), /沒有回傳譯文/);
  assert.throws(() => Core.parseResponse('mymemory', 502, null), /暫時有問題/);
  assert.throws(() => Core.parseResponse('mymemory', 200, null), /沒有回傳譯文/);
});

test('decodeEntities：不認得的原樣留著', () => {
  assert.equal(Core.decodeEntities('&lt;b&gt; &#x4F60;&#22909; &nbsp; &#0; &#99999999;'), '<b> 你好 &nbsp; &#0; &#99999999;');
});

test('cacheKey：來源、語言、原文任何一個不同就不同', () => {
  const a = Core.cacheKey('azure', 'zh', 'en', '你好');
  assert.notEqual(a, Core.cacheKey('mymemory', 'zh', 'en', '你好'));
  assert.notEqual(a, Core.cacheKey('azure', 'zh', 'ja', '你好'));
  assert.notEqual(a, Core.cacheKey('azure', 'zh', 'en', '你好嗎'));
  assert.equal(a, Core.cacheKey('azure', 'zh', 'en', '你好'));
});

test('cleanHistory：壞掉或重複的丟掉', () => {
  const out = Core.cleanHistory([
    E('a', '你好', 'Hello', { fav: true }),
    E('a', '重複 id', 'dup'),
    { id: 'b', from: 'xx', to: 'en', src: 'x', dst: 'y' },
    { id: 'c', from: 'zh', to: 'en', src: '', dst: 'y' },
    null, 'str',
    E('d', '謝謝', 'Thanks', { fav: 'yes', at: 'abc' })
  ]);
  assert.deepEqual(out.map((e) => e.id), ['a', 'd']);
  assert.equal(out[0].fav, true);
  assert.equal(out[1].fav, false);
  assert.equal(out[1].at, 0);
  assert.deepEqual(Core.cleanHistory('nope'), []);
});

test('addHistory：新的放最上面，不改到原本的陣列', () => {
  const a = [E('a', '你好', 'Hello')];
  const r = Core.addHistory(a, E('b', '謝謝', 'Thanks', { at: 2 }));
  assert.deepEqual(r.list.map((e) => e.id), ['b', 'a']);
  assert.equal(r.id, 'b');
  assert.equal(a.length, 1);
});

test('addHistory：同一句再翻一次，搬到最上面、收藏留著、不多一筆', () => {
  const a = [E('a', '你好', 'Hello'), E('b', '謝謝', 'Thanks', { fav: true })];
  const r = Core.addHistory(a, E('new', '謝謝', 'Thank you', { at: 9 }));
  assert.deepEqual(r.list.map((e) => e.id), ['b', 'a']);
  assert.equal(r.id, 'b');
  assert.equal(r.list[0].fav, true);
  assert.equal(r.list[0].dst, 'Thanks', '收藏過的譯文留著');
  assert.equal(r.list[0].at, 9);
  const r2 = Core.addHistory(a, E('new', '你好', 'Hi', { at: 9 }));
  assert.equal(r2.list[0].dst, 'Hi', '沒收藏的更新成新譯文');
  assert.equal(r2.list.length, 2);
});

test('addHistory：同一句但語言不同算不同筆', () => {
  const r = Core.addHistory([E('a', '你好', 'Hello')], E('b', '你好', 'こんにちは', { to: 'ja' }));
  assert.equal(r.list.length, 2);
});

test('addHistory：打字打到一半的草稿會被改掉，不會一直多', () => {
  let list = [], id = null, r;
  for (const [src, dst] of [['請問', 'Excuse me'], ['請問最近的', 'Excuse me, the nearest'], ['請問最近的捷運站怎麼走？', 'How do I get to the MRT?']]) {
    r = Core.addHistory(list, E('n' + src.length, src, dst), { replaceId: id });
    list = r.list; id = r.id;
  }
  assert.equal(list.length, 1);
  assert.equal(list[0].src, '請問最近的捷運站怎麼走？');
  assert.equal(r.draft, true);
});

test('addHistory：刪字縮短不會吃掉翻好的那一句（小修 #2）', () => {
  const r1 = Core.addHistory([], E('a', '我要一杯咖啡', 'A coffee please'));
  const r2 = Core.addHistory(r1.list, E('b', '我要', 'I want'), { replaceId: r1.id });
  const r3 = Core.addHistory(r2.list, E('c', '我要一杯茶', 'A tea please'), { replaceId: r2.id });
  assert.deepEqual(r3.list.map((e) => e.src), ['我要一杯茶', '我要一杯咖啡']);
});

test('addHistory：打到跟舊紀錄同一句，不會把舊紀錄當草稿改掉（小修 #2）', () => {
  const old = [E('old', '你好嗎', 'How are you')];
  const r1 = Core.addHistory(old, E('n1', '你好嗎', 'How are you?'));
  assert.equal(r1.draft, false);
  const r2 = Core.addHistory(r1.list, E('n2', '你好嗎朋友', 'How are you friend'), { replaceId: r1.draft ? r1.id : null });
  assert.deepEqual(r2.list.map((e) => e.src), ['你好嗎朋友', '你好嗎']);
  const r3 = Core.addHistory(r2.list, E('n3', '你好嗎', 'again'), { replaceId: r2.id });
  assert.deepEqual(r3.list.map((e) => e.src), ['你好嗎', '你好嗎朋友']);
});

test('addHistory：收藏過的譯文不會被新的翻譯蓋掉（小修 #6）', () => {
  const list = [E('a', '你好', 'Hello (Azure)', { fav: true })];
  const r = Core.addHistory(list, E('n', '你好', 'Hi (MyMemory)'));
  assert.equal(r.list[0].dst, 'Hello (Azure)');
  assert.equal(r.dst, 'Hello (Azure)');
});

test('addHistory：收藏滿了，新翻的那筆還是留得住（小修 #5）', () => {
  const favs = [1, 2, 3].map((i) => E('f' + i, 'x' + i, 'y', { fav: true }));
  const r = Core.addHistory(favs, E('z', '新的', 'new'), { max: 3 });
  assert.equal(r.list[0].id, 'z');
  assert.equal(r.list.length, 4);
});

test('注音還沒選字先不翻（小修 #1）', () => {
  assert.equal(Core.hasBopomofo('你好ㄇ'), true);
  assert.equal(Core.hasBopomofo('你好嗎 hello'), false);
  assert.match(Core.checkInput('azure', '你好ㄇ', 'zh', 'en'), /注音/);
  assert.equal(Core.checkInput('azure', 'ㄅㄆㄇ', 'ja', 'zh'), '', '原文不是中文就不擋');
});

test('keyProblem / 壞設定（小修 #8、#12）', () => {
  assert.equal(Core.keyProblem(''), '');
  assert.equal(Core.keyProblem('abcDEF0123'), '');
  assert.match(Core.keyProblem('金鑰abc'), /重新/);
  assert.match(Core.keyProblem('abc def'), /重新/);
  assert.deepEqual([S({ from: 'en', to: 'en' }).from, S({ from: 'en', to: 'en' }).to], ['en', 'zh']);
  assert.deepEqual([S({ from: 'ja', to: 'ja' }).from, S({ from: 'ja', to: 'ja' }).to], ['ja', 'en']);
  assert.equal(Core.normalizeText('好\uD83D'), '好');
  assert.equal(Core.normalizeText('\uDE00好'), '好');
  assert.equal(Core.normalizeText('好😀'), '好😀');
  assert.equal(Core.cleanHistory([E('constructor', '你好', 'Hello'), E('__proto__', '謝謝', 'Thanks')]).length, 2);
});

test('Azure 403：只有 403001 才說額度用完（小修 #7）', () => {
  assert.throws(() => Core.parseResponse('azure', 403, { error: { code: 403000 } }), /不允許/);
  assert.throws(() => Core.parseResponse('azure', 403, { error: { code: 403001 } }), /額度用完/);
});

test('addHistory：換了一句不相干的，草稿留著、另外加一筆', () => {
  const r1 = Core.addHistory([], E('a', '你好', 'Hello'));
  const r2 = Core.addHistory(r1.list, E('b', '多少錢', 'How much'), { replaceId: r1.id });
  assert.deepEqual(r2.list.map((e) => e.src), ['多少錢', '你好']);
});

test('addHistory：收藏過的草稿不會被改掉', () => {
  const r1 = Core.addHistory([], E('a', '請問', 'Excuse me'));
  const faved = Core.toggleFav(r1.list, r1.id);
  const r2 = Core.addHistory(faved, E('b', '請問一下', 'May I ask'), { replaceId: r1.id });
  assert.equal(r2.list.length, 2);
  assert.equal(Core.findItem(r2.list, 'a').src, '請問');
  assert.equal(Core.findItem(r2.list, 'a').fav, true);
});

test('addHistory：草稿延伸成一句以前翻過的，合併成舊的那一筆', () => {
  const list = [E('draft', '謝', 'Th'), E('old', '謝謝', 'Thanks', { fav: true })];
  const r = Core.addHistory(list, E('n', '謝謝', 'Thank you'), { replaceId: 'draft' });
  assert.deepEqual(r.list.map((e) => e.id), ['old']);
  assert.equal(r.list[0].fav, true);
});

test('addHistory：超過上限從最舊、沒收藏的開始丟', () => {
  let list = [E('fav-old', '最舊', 'oldest', { fav: true })];
  for (let i = 0; i < 5; i++) list = Core.addHistory(list, E('n' + i, '句子' + i, 's' + i), { max: 3 }).list;
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((e) => e.id), ['n4', 'n3', 'fav-old']);
  // 全部都收藏時不丟
  const favs = [1, 2, 3, 4].map((i) => E('f' + i, 'x' + i, 'y', { fav: true }));
  assert.equal(Core.addHistory(favs, E('z', '新的', 'new'), { max: 3 }).list.filter((e) => e.fav).length, 4);
});

test('toggleFav / removeItem / clearNonFav / findItem', () => {
  const a = [E('a', '你好', 'Hello'), E('b', '謝謝', 'Thanks')];
  const f = Core.toggleFav(a, 'b');
  assert.equal(Core.findItem(f, 'b').fav, true);
  assert.equal(a[1].fav, undefined, '不改到原本的');
  assert.equal(Core.findItem(Core.toggleFav(f, 'b'), 'b').fav, false);
  assert.deepEqual(Core.toggleFav(a, 'zzz').length, 2);
  assert.deepEqual(Core.removeItem(f, 'a').map((e) => e.id), ['b']);
  assert.deepEqual(Core.clearNonFav(f).map((e) => e.id), ['b']);
  assert.equal(Core.findItem(a, 'zzz'), null);
});

test('filterHistory：搜尋原文或譯文、不分大小寫、可以只看收藏', () => {
  const a = [E('a', '你好', 'Hello'), E('b', '謝謝', 'Thanks', { fav: true }), E('c', 'Where is it', '在哪裡', { from: 'en', to: 'zh' })];
  assert.deepEqual(Core.filterHistory(a, {}).length, 3);
  assert.deepEqual(Core.filterHistory(a, { q: 'hello' }).map((e) => e.id), ['a']);
  assert.deepEqual(Core.filterHistory(a, { q: ' 哪裡 ' }).map((e) => e.id), ['c']);
  assert.deepEqual(Core.filterHistory(a, { favOnly: true }).map((e) => e.id), ['b']);
  assert.deepEqual(Core.filterHistory(a, { q: 'hello', favOnly: true }), []);
});

test('翻譯來源選項：自動／固定 MyMemory／固定 Azure', () => {
  assert.equal(S({}).provider, 'auto');
  assert.equal(S({ provider: 'bogus' }).provider, 'auto');
  assert.equal(S({ provider: 'azure' }).provider, 'azure');
  assert.equal(Core.pickProvider(S({})), 'mymemory');
  assert.equal(Core.pickProvider(S({ azureKey: 'k' })), 'azure');
  assert.equal(Core.pickProvider(S({ azureKey: 'k', provider: 'mymemory' })), 'mymemory');
  assert.equal(Core.pickProvider(S({ provider: 'azure' })), 'mymemory');   // 選 Azure 但沒金鑰：先退回 MyMemory
  assert.equal(Core.pickProvider(S({ azureKey: 'k', provider: 'azure' })), 'azure');
});

test('另一家：有金鑰才有 Azure 可比', () => {
  assert.equal(Core.otherProvider(S({}), 'mymemory'), '');
  assert.equal(Core.otherProvider(S({ azureKey: 'k' }), 'mymemory'), 'azure');
  assert.equal(Core.otherProvider(S({ azureKey: 'k' }), 'azure'), 'mymemory');
});

test('常用句：預設、新增、刪除、清理', () => {
  assert.ok(Core.DEFAULT_PHRASES.length >= 8);
  assert.deepEqual(Core.cleanPhrases(null), Core.DEFAULT_PHRASES);
  assert.deepEqual(Core.cleanPhrases([]), []);
  assert.deepEqual(Core.cleanPhrases(['你好', '你好', '', 5, ' 謝謝 ']), ['你好', '謝謝']);
  let r = Core.addPhrase(['a'], '  新的  ');
  assert.deepEqual(r, { list: ['新的', 'a'], error: '' });
  assert.match(Core.addPhrase(['a'], 'a').error, /已經有/);
  assert.match(Core.addPhrase(['a'], '   ').error, /先打/);
  assert.match(Core.addPhrase([], 'x'.repeat(101)).error, /太長/);
  const many = Array.from({ length: Core.PHRASES_MAX }, (_, i) => 'p' + i);
  assert.match(Core.addPhrase(many, '新的').error, /最多/);
  assert.deepEqual(Core.removePhrase(['a', 'b'], 'a'), ['b']);
  for (const p of Core.DEFAULT_PHRASES) assert.equal(Core.addPhrase([], p).error, '');
});

/* ---------- 照片翻譯（Azure Vision） ---------- */

test('Vision 端點：只收 Azure 的網址，結尾斜線、大小寫都整理好', () => {
  assert.equal(Core.normalizeEndpoint('https://tac508.cognitiveservices.azure.com/'), 'https://tac508.cognitiveservices.azure.com');
  assert.equal(Core.normalizeEndpoint('  https://TAC508.cognitiveservices.azure.com  '), 'https://tac508.cognitiveservices.azure.com');
  assert.equal(Core.normalizeEndpoint('https://tac508.cognitiveservices.azure.com'), 'https://tac508.cognitiveservices.azure.com');
  // 不是 Azure、不是 https、夾帶別的網域或路徑：一律不收，金鑰才不會被送到別的地方
  assert.equal(Core.normalizeEndpoint('http://tac508.cognitiveservices.azure.com/'), '');
  assert.equal(Core.normalizeEndpoint('https://evil.com/tac508.cognitiveservices.azure.com'), '');
  assert.equal(Core.normalizeEndpoint('https://a.b.cognitiveservices.azure.com/'), '');
  assert.equal(Core.normalizeEndpoint('https://tac508.cognitiveservices.azure.com.evil.com/'), '');
  assert.equal(Core.normalizeEndpoint('https://tac508.cognitiveservices.azure.com/computervision'), '');
  assert.equal(Core.normalizeEndpoint(123), '');
  assert.equal(Core.endpointProblem(''), '');
  assert.equal(Core.endpointProblem('https://tac508.cognitiveservices.azure.com/'), '');
  assert.match(Core.endpointProblem('tac508'), /cognitiveservices/);
  assert.equal(S({ visionEndpoint: 'https://x.example.com' }).visionEndpoint, '');
  assert.equal(S({ visionKey: ' k ' }).visionKey, 'k');
});

test('visionReady：金鑰和端點都要有', () => {
  assert.equal(Core.visionReady(S({})), false);
  assert.equal(Core.visionReady(S({ visionKey: 'k' })), false);
  assert.equal(Core.visionReady(S({ visionEndpoint: 'https://a.cognitiveservices.azure.com/' })), false);
  assert.equal(Core.visionReady(S({ visionKey: 'k', visionEndpoint: 'https://a.cognitiveservices.azure.com/' })), true);
  // 翻譯用的 Azure 金鑰跟照片用的是兩把，互不影響
  assert.equal(Core.visionReady(S({ azureKey: 'k' })), false);
});

test('buildVisionRequest：送到 Read，帶金鑰，照片直接放 body', () => {
  const s = S({ visionKey: 'vk', visionEndpoint: 'https://tac508.cognitiveservices.azure.com/' });
  const img = { fake: 'blob' };
  const r = Core.buildVisionRequest(img, s);
  assert.equal(r.url, 'https://tac508.cognitiveservices.azure.com/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read');
  assert.equal(r.options.method, 'POST');
  assert.equal(r.options.headers['Ocp-Apim-Subscription-Key'], 'vk');
  assert.equal(r.options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(r.options.body, img);
  assert.throws(() => Core.buildVisionRequest(img, S({})), /設定/);
});

test('parseVisionResponse：一行一行接起來，空白行丟掉', () => {
  const ok = { readResult: { blocks: [
    { lines: [{ text: ' 牛肉麵  $150 ' }, { text: '' }, { text: '滷肉飯 $40' }] },
    { lines: [{ text: 'Open 11:00' }, { nope: 1 }, null] }
  ] } };
  assert.equal(Core.parseVisionResponse(200, ok), '牛肉麵 $150\n滷肉飯 $40\nOpen 11:00');
});

test('parseVisionResponse：沒讀到字、回傳怪怪的', () => {
  assert.throws(() => Core.parseVisionResponse(200, { readResult: { blocks: [] } }), /沒有讀到文字/);
  assert.throws(() => Core.parseVisionResponse(200, { readResult: { blocks: [{ lines: [{ text: '   ' }] }] } }), /沒有讀到文字/);
  assert.throws(() => Core.parseVisionResponse(200, {}), /沒有回傳文字/);
  assert.throws(() => Core.parseVisionResponse(200, null), /沒有回傳文字/);
});

test('parseVisionResponse：各種錯誤都變成看得懂的中文', () => {
  assert.throws(() => Core.parseVisionResponse(401, { error: { code: '401', message: 'Access denied' } }), /金鑰不對/);
  assert.throws(() => Core.parseVisionResponse(403, null), /免費額度/);
  assert.throws(() => Core.parseVisionResponse(404, null), /端點/);
  assert.throws(() => Core.parseVisionResponse(429, null), /等一下再試/);
  assert.throws(() => Core.parseVisionResponse(400, { error: { code: 'InvalidRequest', message: 'Image format is not valid.', innererror: { code: 'InvalidImageFormat' } } }), /格式不支援/);
  assert.throws(() => Core.parseVisionResponse(400, { error: { code: 'InvalidRequest', message: 'The image size is not allowed to be zero or larger than 20971520 bytes' } }), /太大/);
  assert.throws(() => Core.parseVisionResponse(400, { error: { code: 'InvalidRequest', message: 'Analyze query is invalid.' } }), /InvalidRequest/);
  assert.throws(() => Core.parseVisionResponse(503, null), /暫時有問題/);
  assert.throws(() => Core.parseVisionResponse(418, null), /418/);
});

test('fitSize：太大就等比縮小，小的不放大', () => {
  assert.deepEqual(Core.fitSize(4000, 3000, 2000), { w: 2000, h: 1500 });
  assert.deepEqual(Core.fitSize(3000, 4000, 2000), { w: 1500, h: 2000 });
  assert.deepEqual(Core.fitSize(800, 600, 2000), { w: 800, h: 600 });
  assert.deepEqual(Core.fitSize(2000, 2000, 2000), { w: 2000, h: 2000 });
  assert.deepEqual(Core.fitSize(9000, 10, 2000), { w: 2000, h: 2 });
  assert.deepEqual(Core.fitSize(0, 10), { w: 0, h: 0 });
  assert.deepEqual(Core.fitSize(4000, 3000), { w: Core.PHOTO_MAX_SIDE, h: Core.PHOTO_MAX_SIDE * 0.75 });
});

test('limitText：照片字太多只留前面，不會切壞 emoji', () => {
  assert.deepEqual(Core.limitText('你好', 5), { text: '你好', cut: false });
  assert.deepEqual(Core.limitText('一二三四五六', 3), { text: '一二三', cut: true });
  assert.deepEqual(Core.limitText('😀😀😀', 2), { text: '😀😀', cut: true });
  const long = Core.limitText('字'.repeat(1200));
  assert.equal(long.cut, true);
  assert.equal(Core.countChars(long.text), Core.MAX_LEN);
  assert.equal(Core.checkInput('azure', long.text, 'zh', 'en'), '');   // 截完一定翻得了
});

test('照片語言：Azure 代碼對回 App 的語言', () => {
  assert.equal(Core.langByAzure('vi').id, 'vi');
  assert.equal(Core.langByAzure('zh-Hant').id, 'zh');
  assert.equal(Core.langByAzure('zh-hans').id, 'zhs');
  assert.equal(Core.langByAzure('pt-pt').id, 'pt');
  assert.equal(Core.langByAzure('tl').id, 'fil');
  assert.equal(Core.langByAzure('sw'), null);      // 不在 20 種裡面
  assert.equal(Core.langByAzure(''), null);
});

test('photoPair：外文翻成中文；中文翻成另一邊；認不出來不動', () => {
  assert.deepEqual(Core.photoPair('vi', 'zh', 'en'), { from: 'vi', to: 'zh', known: true });
  assert.deepEqual(Core.photoPair('ja', 'zh', 'ja'), { from: 'ja', to: 'zh', known: true });
  assert.deepEqual(Core.photoPair('en', 'ko', 'th'), { from: 'en', to: 'zh', known: true });
  assert.deepEqual(Core.photoPair('zh-Hans', 'zh', 'en'), { from: 'zhs', to: 'zh', known: true });  // 簡體轉繁體
  assert.deepEqual(Core.photoPair('zh-Hant', 'zh', 'ja'), { from: 'zh', to: 'ja', known: true });
  assert.deepEqual(Core.photoPair('zh-Hant', 'th', 'zh'), { from: 'zh', to: 'th', known: true });
  assert.deepEqual(Core.photoPair('zh-Hant', 'ko', 'th'), { from: 'zh', to: 'ko', known: true });
  assert.deepEqual(Core.photoPair('sw', 'zh', 'en'), { from: 'zh', to: 'en', known: false });
  assert.deepEqual(Core.photoPair('', 'ja', 'zh'), { from: 'ja', to: 'zh', known: false });
});

test('detect：請求帶翻譯金鑰和地區，字太長只送前 500 字；回應壞掉回空字串', () => {
  const r = Core.buildDetectRequest('字'.repeat(800), S({ azureKey: 'tk', azureRegion: 'eastasia' }));
  assert.equal(r.url, 'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0');
  assert.equal(r.options.headers['Ocp-Apim-Subscription-Key'], 'tk');
  assert.equal(r.options.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
  assert.equal(Core.countChars(JSON.parse(r.options.body)[0].Text), 500);
  assert.equal(Core.parseDetectResponse(200, [{ language: 'vi', score: 1 }]), 'vi');
  assert.equal(Core.parseDetectResponse(401, { error: { code: 401000 } }), '');
  assert.equal(Core.parseDetectResponse(200, []), '');
  assert.equal(Core.parseDetectResponse(200, null), '');
});
