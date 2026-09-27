"""Validate the single-file episode catalog: python check.py index.html."""

import html
import json
import re
import sys
from pathlib import Path


source = Path(sys.argv[1]).read_text(encoding="utf-8")
script = re.search(r"<script>(.*)</script>", source, re.S).group(1)


def block(name, closing):
    opening = "[" if closing == "]" else "{"
    start = script.index(f"var {name} = {opening}")
    end = script.index(f"\n{closing};", start)
    return script[start : end + 3]


people_block = block("PEOPLE", "]")
episodes_block = block("EPISODES", "]")
colors_block = block("FIELD_COLORS", "}")
person_ids = re.findall(r'\{ id:"([^"]+)", name:', people_block)
person_names = re.findall(r'\{ id:"[^"]+", name:"([^"]+)"', people_block)
fields = set(re.findall(r'\bfield:"([^"]+)"', people_block))
colors = set(re.findall(r'^\s*"([^"]+)": "#[0-9A-Fa-f]{6}"', colors_block, re.M))

js_string = r'"(?:\\.|[^"\\])*"'
episode_pattern = re.compile(
    rf"\{{ id:({js_string}), personId:({js_string}), title:({js_string}), "
    rf"tags:(\[[^\]]*\]),\s*body:({js_string}),\s*bodyHtml:({js_string})"
    rf", titleHtml:({js_string})"
    rf"(?:, source:({js_string}), sourceId:({js_string}))? \}}",
    re.S,
)
episodes = episode_pattern.findall(episodes_block)
ok = True


def fail(message):
    global ok
    print("NG:", message)
    ok = False


if len(person_ids) != len(set(person_ids)):
    fail("人物IDが重複")
if len(person_names) != len(set(person_names)):
    fail("人物名が重複")
if len(person_ids) != people_block.count("{ id:"):
    fail("人物データをすべて読み取れませんでした")
if len(episodes) != episodes_block.count("{ id:"):
    fail("エピソードをすべて読み取れませんでした")

episode_ids = []
episode_person_ids = set()
for raw_id, raw_person_id, raw_title, raw_tags, raw_body, raw_html, raw_title_html, raw_source, raw_source_id in episodes:
    eid = json.loads(raw_id)
    person_id = json.loads(raw_person_id)
    title = json.loads(raw_title)
    tags = json.loads(raw_tags)
    body = json.loads(raw_body)
    body_html = json.loads(raw_html)
    title_html = json.loads(raw_title_html)
    origin = json.loads(raw_source) if raw_source else None
    episode_ids.append(eid)
    episode_person_ids.add(person_id)
    if not re.fullmatch(re.escape(person_id) + r"-\d{2}", eid):
        fail(f"エピソードIDとpersonIdが不一致: {eid}")
    if not title or not tags:
        fail(f"見出しまたはタグが空: {eid}")
    if origin not in (None, "legacy"):
        fail(f"不明なデータ出典: {eid}")
    if origin == "legacy" and not raw_source_id:
        fail(f"旧版の元IDがありません: {eid}")
    if origin is None and len(tags) != 3:
        fail(f"新形式のタグは3件にしてください: {eid}")
    for label, original, markup in [("body", body, body_html), ("title", title, title_html)]:
        ruby_pattern = r"<ruby>([^<>]+)<rt>([^<>]+)</rt></ruby>"
        pairs = re.findall(ruby_pattern, markup)
        outside = re.sub(ruby_pattern, "", markup)
        if re.search(r"[\u3400-\u9fff々〆〇]", html.unescape(outside)):
            fail(f"{label}にルビのない漢字: {eid}")
        if re.search(r"[<>]", outside):
            fail(f"{label}に不正なルビタグ: {eid}")
        for base, reading in pairs:
            if not re.search(r"[ぁ-ゖァ-ヶ]", html.unescape(reading)) or re.search(r"[\u3400-\u9fff々〆〇]", html.unescape(reading)):
                fail(f"{label}の読みを確認: {eid} {base}={reading}")
        plain = html.unescape(re.sub(ruby_pattern, lambda m: m[1], markup))
        if plain != original:
            fail(f"{label}と{label}Htmlが不一致: {eid}")
    if origin != "legacy" and not (250 <= len(body) <= 420):
        print("注意: 文字数", eid, len(body))

if len(episode_ids) != len(set(episode_ids)):
    fail("エピソードIDが重複")
for missing in sorted(set(person_ids) - episode_person_ids):
    fail(f"エピソードのない人物: {missing}")
for orphan in sorted(episode_person_ids - set(person_ids)):
    fail(f"人物マスタにないpersonId: {orphan}")
for field in sorted(fields - colors):
    fail(f"FIELD_COLORSに無い分野: {field}")

counts = [int(n) for n in re.findall(r"(\d+)人収録", source)]
if counts and any(n != len(person_ids) for n in counts):
    fail(f"人数表記が人物数と不一致: {counts}")

print("人物数:", len(person_ids), "エピソード数:", len(episodes))
print("OK" if ok else "NGあり")
sys.exit(0 if ok else 1)
