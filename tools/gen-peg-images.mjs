#!/usr/bin/env node
/**
 * 숫자 페그 타로카드 일괄 생성기 (OpenAI Images API)
 *
 *   OPENAI_API_KEY=sk-... node tools/gen-peg-images.mjs
 *
 * docs/pegs.js 의 110개 항목을 읽어 docs/img/<자릿수>/<키>.webp 로 저장한다.
 * 이미 있는 파일은 건너뛰므로 중간에 끊겨도 그냥 다시 실행하면 이어서 만든다.
 *
 * 옵션
 *   --only 5,42,83     지정한 키만 생성 (쉼표 구분)
 *   --force            이미 있는 파일도 다시 생성
 *   --model <이름>     기본 gpt-image-2 (없는 모델이면 gpt-image-1 로 자동 대체)
 *   --size <WxH>       기본 1024x1536 (타로카드 세로 2:3)
 *   --quality <등급>   low | medium | high   (기본 medium)
 *   --format <형식>    webp | png            (기본 webp)
 *   --concurrency <n>  동시 요청 수          (기본 3)
 *   --dry-run          호출 없이 최종 프롬프트만 출력
 *   --list-missing     아직 없는 키만 나열하고 종료
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = path.join(ROOT, "docs/pegs.js");
const IMG_DIR = path.join(ROOT, "docs/img");
const ENDPOINT = "https://api.openai.com/v1/images/generations";

/* 110장을 한 덱으로 묶어주는 공통 스타일. 여기를 바꾸면 덱 전체의 인상이 바뀐다. */
const STYLE = [
  "A symbolist tarot card illustration in the manner of a hand-painted early twentieth century esoteric arcana deck:",
  "flat storybook painting with heavy ink outlines, art-nouveau woodcut feeling, and a slim ornate border frame around the scene.",
  "Limited palette of dull gold, oxblood red, midnight blue, sage green and bone white on aged parchment.",
  "Strange, dreamlike and faintly mischievous — floating symbols, an oversized moon or sun, drifting stars,",
  "a checkered floor, twin pillars or heavy drapery.",
  "One dominant figure or object centered and filling the card, bold silhouette, strong contrast,",
  "composed so it still reads clearly when shrunk to a thumbnail.",
].join(" ");
const NO_TEXT = " No text, no lettering, no roman numerals, no writing on any banner or plaque — leave every banner blank. No watermark, no signature.";
const SOME_TEXT = " The only lettering anywhere is the few digits described above, engraved plainly. No other text, no title banner writing, no watermark, no signature.";

/* ── 인자 파싱 ────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OPTS = {
  only: opt("only", "").split(",").map((s) => s.trim()).filter(Boolean),
  force: flag("force"),
  model: opt("model", process.env.PEG_IMAGE_MODEL || "gpt-image-2"),
  size: opt("size", "1024x1536"),
  quality: opt("quality", "medium"),
  format: opt("format", "webp"),
  concurrency: Math.max(1, Number(opt("concurrency", "3")) || 3),
  dryRun: flag("dry-run"),
  listMissing: flag("list-missing"),
};

/* ── 데이터 로드 ──────────────────────────────────────────── */
function loadPegs() {
  const src = fs.readFileSync(DATA_FILE, "utf8");
  const sandbox = {};
  new Function("window", src)(sandbox);
  if (!sandbox.PEG_DATA) throw new Error(`${DATA_FILE} 에서 PEG_DATA 를 찾지 못했습니다.`);
  return sandbox.PEG_DATA;
}

const PEGS = loadPegs();
const outPath = (key) => path.join(IMG_DIR, String(key.length), `${key}.${OPTS.format}`);
const buildPrompt = (peg) => `${peg.prompt}. ${STYLE}${peg.text ? SOME_TEXT : NO_TEXT}`;

let targets = Object.keys(PEGS).sort((a, b) => a.length - b.length || a.localeCompare(b));
if (OPTS.only.length) {
  const unknown = OPTS.only.filter((k) => !PEGS[k]);
  if (unknown.length) {
    console.error(`알 수 없는 키: ${unknown.join(", ")}`);
    process.exit(1);
  }
  targets = OPTS.only;
}
if (!OPTS.force) targets = targets.filter((k) => !fs.existsSync(outPath(k)));

if (OPTS.listMissing) {
  console.log(targets.join("\n"));
  console.log(`\n남은 개수: ${targets.length}`);
  process.exit(0);
}

if (OPTS.dryRun) {
  for (const key of targets) console.log(`\n[${key}] ${PEGS[key].label}\n${buildPrompt(PEGS[key])}`);
  console.log(`\n총 ${targets.length}개 (dry-run, 호출하지 않음)`);
  process.exit(0);
}

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("OPENAI_API_KEY 환경변수가 없습니다.");
  console.error("  로컬:   OPENAI_API_KEY=sk-... node tools/gen-peg-images.mjs");
  console.error("  Actions: 레포 Settings → Secrets and variables → Actions 에 OPENAI_API_KEY 등록");
  process.exit(1);
}

/* ── API 호출 ─────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 모델·파라미터 지원 범위는 계정과 모델 세대마다 달라서, 서버가 거부하면 깎아내며 재시도한다 */
let model = OPTS.model;
const dropped = new Set();

function body(peg) {
  const b = {
    model,
    prompt: buildPrompt(peg),
    n: 1,
    size: OPTS.size,
    quality: OPTS.quality,
    output_format: OPTS.format,
    moderation: "low",
  };
  for (const k of dropped) delete b[k];
  return b;
}

async function generate(key) {
  const peg = PEGS[key];
  const MAX = 6;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let res, text;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body(peg)),
      });
      text = await res.text();
    } catch (err) {
      if (attempt === MAX) throw err;
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) {
      const json = JSON.parse(text);
      const b64 = json?.data?.[0]?.b64_json;
      if (!b64) throw new Error(`응답에 이미지가 없습니다: ${text.slice(0, 300)}`);
      const file = outPath(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      return file;
    }

    const parsed = (() => { try { return JSON.parse(text)?.error || {}; } catch { return {}; } })();
    const msg = parsed.message || text;
    const param = parsed.param;

    if (res.status === 400 || res.status === 404) {
      /* 모델 이름이 안 맞으면 한 세대 이전 모델로 자동 대체 */
      if (/model/i.test(msg) && /(not (found|exist)|does not exist|unsupported|unknown|invalid)/i.test(msg) && model !== "gpt-image-1") {
        console.warn(`! 모델 ${model} 사용 불가 → gpt-image-1 로 대체합니다. (${msg})`);
        model = "gpt-image-1";
        attempt--;
        continue;
      }
      /* 지원하지 않는 파라미터면 빼고 재시도 */
      const bad = (param && param !== "prompt" && param !== "model") ? param
        : (msg.match(/[Uu]n(?:known|recognized|supported)[^']*'([a-z_]+)'/) || [])[1];
      if (bad && !dropped.has(bad) && bad !== "prompt" && bad !== "model") {
        console.warn(`! 파라미터 ${bad} 미지원 → 제외하고 재시도합니다.`);
        dropped.add(bad);
        attempt--;
        continue;
      }
      /* 안전 필터 거부는 재시도해도 소용없다 — 프롬프트를 손봐야 한다 */
      if (/safety|moderation|policy|rejected|not allowed/i.test(msg)) throw new Error(`SAFETY: ${msg}`);
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * 2 ** (attempt - 1);
      if (attempt === MAX) throw new Error(`${res.status} ${msg}`);
      console.warn(`  · ${key} ${res.status} — ${Math.round(wait / 1000)}초 후 재시도 (${attempt}/${MAX})`);
      await sleep(wait);
      continue;
    }

    throw new Error(`${res.status} ${msg}`);
  }
}

/* ── 실행 ─────────────────────────────────────────────────── */
console.log(`모델 ${model} / ${OPTS.size} / quality=${OPTS.quality} / ${OPTS.format} / 동시 ${OPTS.concurrency}`);
console.log(`생성 대상 ${targets.length}개${OPTS.force ? " (--force)" : " (기존 파일은 건너뜀)"}\n`);
if (!targets.length) { console.log("만들 것이 없습니다. 끝."); process.exit(0); }

const failed = [];
let done = 0;
const queue = [...targets];

async function worker() {
  while (queue.length) {
    const key = queue.shift();
    const peg = PEGS[key];
    try {
      const file = await generate(key);
      done++;
      console.log(`✔ [${String(done).padStart(3)}/${targets.length}] ${key.padEnd(2)} ${peg.label} → ${path.relative(ROOT, file)}`);
    } catch (err) {
      failed.push({ key, label: peg.label, reason: String(err.message || err) });
      console.error(`✘ ${key} ${peg.label} — ${err.message || err}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(OPTS.concurrency, targets.length) }, worker));

console.log(`\n완료: ${done}개 성공, ${failed.length}개 실패`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.key} ${f.label}: ${f.reason}`);
  console.log(`\n실패분만 다시: node tools/gen-peg-images.mjs --only ${failed.map((f) => f.key).join(",")}`);
  console.log("SAFETY 로 거부된 항목은 docs/pegs.js 의 prompt 를 순화한 뒤 다시 돌리면 됩니다.");
  process.exit(1);
}
