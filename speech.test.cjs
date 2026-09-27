const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const source = fs.readFileSync(__dirname + '/index.html', 'utf8');

function setup() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value:'', disabled:false, hidden:true, textContent:'', innerHTML:'', listeners:{},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      trigger(name) { this.listeners[name]?.(); }
    });
    return elements.get(id);
  }
  const synth = {
    voices:[], calls:[], listeners:new Set(), paused:false,
    getVoices() { return this.voices; },
    speak(utterance) { this.calls.push(utterance); },
    cancel() { this.paused = false; },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    addEventListener(name, fn) { this.listeners.add(fn); },
    removeEventListener(name, fn) { this.listeners.delete(fn); },
    voicesChanged() { this.listeners.forEach(fn => fn()); }
  };
  class Utterance { constructor(text) { this.text = text; } }
  const context = vm.createContext({
    window:{speechSynthesis:synth, SpeechSynthesisUtterance:Utterance},
    SpeechSynthesisUtterance:Utterance,
    document:{getElementById:element},
    detailSection:{querySelectorAll:()=>[]}, closeDetail:()=>{}
  });
  vm.runInContext(source.match(/var PEOPLE = \[[\s\S]*?\n\];/)[0], context);
  vm.runInContext(source.match(/var EPISODES = \[[\s\S]*?\n\];/)[0], context);
  vm.runInContext(source.slice(source.indexOf('function escapeHtml('),source.indexOf('function renderAvatar(')),context);
  vm.runInContext(source.slice(source.indexOf('/* 音読用の読み。'),source.indexOf('function openDetail(')),context);
  const person = id => context.PEOPLE.find(p=>p.id===id);
  const episodes = id => context.EPISODES.filter(e=>e.personId===id);
  const bind = id => context.bindDetailControls(person(id),episodes(id));
  return {context, synth, element, person, episodes, bind};
}
const voice = (name='日本語A', lang='ja-JP', localService=true, isDefault=true) =>
  ({name, lang, localService, default:isDefault, voiceURI:name});

test('ruby readings replace their bases exactly once, including fallback parentheses and entities',()=>{
  const {context:c} = setup();
  assert.equal(c.rubySpeechText('<ruby>志<rt>こころざ</rt></ruby>す。<ruby>空海<rp>（</rp><rt>くうかい</rt><rp>）</rp></ruby>とAT&amp;T。'),
    'こころざす。くうかいとAT&T。');
});

test('corrected names and their old records remain available',()=>{
  const {context:c,person,episodes} = setup();
  for(const [id,reading] of Object.entries({N04:'のよりりょうじ',N17:'まなべしゅくろう',J04:'くうかい',J69:'くさかげんずい',J70:'おおくぼとしみち',J55:'だいこくやこうだゆう',J59:'たむららんすい'})) {
    assert.equal(person(id).reading,reading);
    assert(person(id).legacyReading);
    assert(c.buildSpeechChunks(person(id),episodes(id)).join('').includes(reading),id);
  }
  assert.equal(person('J55').name,'大黒屋光太夫');
  assert.equal(person('J55').legacyName,'大黒屋光太郎');
});

test('existing ruby vocabulary is also used in legacy episodes and headings',()=>{
  const {context:c,person,episodes} = setup();
  const old = episodes('001').find(e=>e.source==='legacy');
  const fallback={...old,titleHtml:undefined,bodyHtml:old.body};
  const text=c.buildSpeechChunks(person('001'),[fallback]).join('');
  assert(text.includes('のぐちひでよ'));
  assert(text.includes('いろり'));
  assert(text.includes('おうねつびょう'));
  assert(!text.includes('黄熱病'));
});

test('longest names win; short personal names do not change other kanji words',()=>{
  const {context:c,person}=setup();
  const entries=c.buildSpeechReadings(person('070'),{id:'test'});
  assert.equal(c.applySpeechReadings('大谷翔平と翔平。大谷石と志。',entries),'おおたにしょうへいとしょうへい。大谷石と志。');
});

test('per-episode overrides are scoped; explicit ruby takes precedence',()=>{
  const {context:c,person}=setup();
  const original=c.applySpeechReadings('上方',c.buildSpeechReadings(person('001'),{id:'other'}));
  c.SPEECH_EPISODE_READINGS['test-01']={'上方':'かみがた'};
  const ep={id:'test-01',title:'上方',bodyHtml:'上方。<ruby>上方<rt>じょうほう</rt></ruby>。'};
  assert.equal(c.buildSpeechChunks(person('001'),[ep]).join(''),'かみがた。かみがた。じょうほう。');
  assert.equal(c.applySpeechReadings('上方',c.buildSpeechReadings(person('001'),{id:'other'})),original);
});

test('all 296 episodes produce speech without HTML markup, with unchanged catalog data',()=>{
  const {context:c,person}=setup();
  const before=JSON.stringify(c.EPISODES);
  for(const ep of c.EPISODES) {
    const chunks=c.buildSpeechChunks(person(ep.personId),[ep]);
    assert(chunks.length>1,ep.id);
    assert(!/<\/?(?:ruby|rt|rp)>|&amp;/.test(chunks.join('')),ep.id);
    assert(!/[\u3400-\u9fff々〆〇]/.test(chunks.join('')),ep.id+' has unread kanji');
    assert.equal(chunks[0],c.rubySpeechText(ep.titleHtml)+'。',ep.id+' heading');
  }
  assert.equal(c.EPISODES.length,296);
  assert.equal(c.PEOPLE.length,232);
  assert.equal(JSON.stringify(c.EPISODES),before);
});

test('contextual readings for technical terms, names, compounds and counters are explicit',()=>{
  const {context:c}=setup();
  function reading(base) {
    return c.EPISODES.flatMap(ep=>c.rubyReadings(ep.bodyHtml)).filter(pair=>pair[0]===base).map(pair=>pair[1]);
  }
  for (const [base,expected] of Object.entries({共著者:'きょうちょしゃ',東芝:'とうしば',陽子:'ようし',井深大:'いぶかまさる',大谷吉継:'おおたによしつぐ',田村藍水:'たむららんすい',医学生:'いがくせい',明徳:'めいとく',学問所:'がくもんじょ',一歩:'いっぽ',一冊:'いっさつ',第一国立銀行:'だいいちこくりつぎんこう','150日間':'ひゃくごじゅうにちかん','4000万':'よんせんまん'})) {
    const actual=reading(base);
    assert(actual.length,base+' is covered');
    assert(actual.every(value=>value===expected),base+': '+actual.join(', '));
  }
  const synthetic={id:'test-ruby',title:'共著者',titleHtml:'<ruby>共著者<rt>きょうちょしゃ</rt></ruby>',bodyHtml:'<ruby>三重<rt>さんじゅう</rt></ruby>の<ruby>障<rt>しょう</rt></ruby>がい。'};
  assert.equal(c.buildSpeechChunks(c.PEOPLE[0],[synthetic]).join(''),'きょうちょしゃ。さんじゅうのしょうがい。');
});

test('voice list can arrive late; only local Japanese voices are selectable',()=>{
  const {synth,element,bind}=setup();
  bind('001');
  assert(element('play-btn').disabled);
  synth.voices=[voice('English','en-US'),voice('Remote','ja-JP',false),voice('日本語')];
  synth.voicesChanged();
  assert(!element('play-btn').disabled);
  assert(!element('speech-voice').innerHTML.includes('Remote'));
  element('play-btn').trigger('click');
  assert.equal(synth.calls[0].voice.name,'日本語');
  assert.equal(synth.calls[0].lang,'ja-JP');
});

test('sentence queue, pause/resume, rate changes and stale cancellation callbacks',()=>{
  const {synth,element,bind,context:c}=setup();
  synth.voices=[voice()]; bind('001');
  element('play-btn').trigger('click');
  const title=synth.calls.at(-1); title.onend();
  const body=synth.calls.at(-1);
  assert.notEqual(body.text,title.text);
  element('pause-btn').trigger('click');
  assert(synth.paused);
  element('play-btn').trigger('click');
  assert(!synth.paused);
  element('rate-range').value='0.8'; element('rate-range').trigger('input');
  assert.equal(synth.calls.at(-1).text,body.text);
  assert.equal(synth.calls.at(-1).rate,0.8);
  const count=synth.calls.length; body.onend(); body.onerror({error:'canceled'});
  assert.equal(synth.calls.length,count);
  const pending=synth.calls.at(-1);
  element('stop-btn').trigger('click'); pending.onend();
  assert.equal(synth.calls.length,count);
  element('play-btn').trigger('click');
  assert.equal(synth.calls.at(-1).text,title.text);
  const last=synth.calls.at(-1);
  c.disposeSpeechControls(); last.onend();
  assert.equal(synth.listeners.size,0);
  assert.equal(synth.calls.at(-1),last);
});

test('paused voice changes resume at the same sentence and retain voice across people',()=>{
  const {synth,element,bind,context:c}=setup();
  synth.voices=[voice(),voice('日本語B','ja_JP',true,false)]; bind('001');
  element('play-btn').trigger('click'); synth.calls.at(-1).onend();
  const sentence=synth.calls.at(-1).text;
  element('pause-btn').trigger('click');
  element('speech-voice').value='日本語B'; element('speech-voice').trigger('change');
  element('play-btn').trigger('click');
  assert.equal(synth.calls.at(-1).text,sentence);
  assert.equal(synth.calls.at(-1).voice.name,'日本語B');
  c.disposeSpeechControls(); bind('002');
  assert.equal(element('speech-voice').value,'日本語B');
});

test('stop resets the saved position after changing speed while paused',()=>{
  const {synth,element,bind}=setup();
  synth.voices=[voice()]; bind('001');
  element('play-btn').trigger('click');
  const title=synth.calls.at(-1).text;
  synth.calls.at(-1).onend();
  element('pause-btn').trigger('click');
  element('rate-range').value='0.8'; element('rate-range').trigger('input');
  assert(!element('stop-btn').disabled);
  element('stop-btn').trigger('click');
  assert(element('stop-btn').disabled);
  element('play-btn').trigger('click');
  assert.equal(synth.calls.at(-1).text,title);
});

test('engine errors re-enable playback and completion can restart from the heading',()=>{
  const {synth,element,bind}=setup();
  synth.voices=[voice()]; bind('070');
  element('play-btn').trigger('click'); const title=synth.calls.at(-1).text;
  synth.calls.at(-1).onerror({error:'synthesis-failed'});
  assert(element('speech-status').textContent.includes('続けられません'));
  assert(!element('play-btn').disabled);
  element('play-btn').trigger('click');
  let guard=0;
  while(element('speech-status').textContent==='読み上げ中' && guard++<100) synth.calls.at(-1).onend();
  assert.equal(element('speech-status').textContent,'読み上げが終わりました。');
  element('play-btn').trigger('click'); assert.equal(synth.calls.at(-1).text,title);
});
