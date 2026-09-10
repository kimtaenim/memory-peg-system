#!/usr/bin/env node
/**
 * 숫자 페그 타로카드 일괄 생성기 (OpenAI Images API)
 *
 *   OPENAI_API_KEY=sk-... node tools/gen-peg-images.mjs
 *
 * 데이터는 전부 JSON 에 있다 (이 파일에 하드코딩된 페그/프롬프트는 없다):
 *   docs/data/pegs.json     숫자 → 키워드
 *   docs/data/prompts.json  덱 공통 화풍(style) + 항목별 장면(items)
 * 읽어서 docs/img/<자릿수>/<키>.webp 로 저장한다.
 * 이미 있는 파일은 건너뛰므로 중간에 끊겨도 그냥 다시 실행하면 이어서 만든다.
 *
 * 옵션
 *   --only 5,42,83     지정한 키만 생성 (쉼표 구분)
 *   --force            이미 있는 파일도 다시 생성
 *   --model <이름>     기본 gpt-image-2 (없는 모델이면 gpt-image-1 로 자동 대체)
 *   --size <WxH>       기본 1024x1536 (타로카드 세로 2:3)
 *   --quality <등급>   low | medium | high   (기본 low — 작게 보는 카드라 충분하고 가장 싸다)
 *   --format <형식>    webp | png            (기본 webp)
 *   --concurrency <n>  동시 요청 수          (기본 3)
 *   --max-width <px>   저장 전에 cwebp 로 이 너비로 축소 (기본 768, 0이면 원본 유지)
 *   --webp-quality <q> 축소할 때 webp 품질     (기본 82)
 *   --dry-run          호출 없이 최종 프롬프트만 출력
 *   --list-missing     아직 없는 키만 나열하고 종료
 *   --edit             편집 모드: 새로 그리지 않고 참조 이미지를 고친다 (images/edits)
 *
 * 편집 모드 (--edit)
 *   마음에 드는 그림을 살리면서 한 부분만 손볼 때 쓴다. prompts.json 의 항목에
 *     "edit":     무엇을 어떻게 고칠지 (이 문장만 보내고 덱 공통 화풍은 붙이지 않는다 — 참조 그림이 화풍을 들고 있다)
 *     "editMask": { "x", "y", "w", "h" }  다시 그릴 영역(카드 폭·높이에 대한 비율, 0~1). 없으면 그림 전체를 참조로 고친다
 *     "ref":      참조 이미지 경로 (기본 tools/refs/<키>.webp, 없으면 현재 카드 docs/img/<자릿수>/<키>.webp)
 *   를 적고 `--edit --only 3` 처럼 돌린다. 편집 모드는 항상 기존 카드를 덮어쓴다(--force 불필요).
 *   마스크 밖은 원본 픽셀이 그대로 남으므로, 얼굴·배경·숫자 배너를 지키면서 한 곳만 바꿀 수 있다.
 *
 * API 가 주는 webp 는 1024x1536 무손실이라 장당 2MB 가 넘는다. 폰에서는 3장 나란히
 * 띄워도 카드 한 장이 600px 을 넘지 않으므로 cwebp(libwebp) 가 깔려 있으면 768px 로
 * 줄여 ~200KB 로 저장한다. cwebp 가 없으면 API 쪽 압축(output_compression)만 적용된다.
 *   설치: macOS `brew install webp` / Ubuntu `sudo apt install webp` / Windows `winget install Google.libwebp`
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PEGS_FILE = path.join(ROOT, "docs/data/pegs.json");
const PROMPTS_FILE = path.join(ROOT, "docs/data/prompts.json");
const IMG_DIR = path.join(ROOT, "docs/img");
const ENDPOINT = "https://api.openai.com/v1/images/generations";
const EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";
const REF_DIR = path.join(ROOT, "tools/refs");

/* ── 인자 파싱 ────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OPTS = {
  /* "only 5, 42,83" 처럼 단어·공백·따옴표가 섞여 들어와도 숫자 토큰만 뽑는다 */
  only: (opt("only", "").match(/\d+/g) || []),
  force: flag("force"),
  model: opt("model", process.env.PEG_IMAGE_MODEL || "gpt-image-2"),
  size: opt("size", "1024x1536"),
  quality: opt("quality", "low"),
  format: opt("format", "webp"),
  concurrency: Math.max(1, Number(opt("concurrency", "3")) || 3),
  maxWidth: Math.max(0, Number(opt("max-width", "768")) || 0),
  webpQuality: Math.min(100, Math.max(1, Number(opt("webp-quality", "82")) || 82)),
  dryRun: flag("dry-run"),
  listMissing: flag("list-missing"),
  edit: flag("edit"),
};

/* ── 데이터 로드 ──────────────────────────────────────────── */
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`${path.relative(ROOT, file)} 을 읽지 못했습니다: ${err.message}`);
    process.exit(1);
  }
};

const PEGS = readJson(PEGS_FILE);                 // { "42": "싸이", ... }
const PROMPTS = readJson(PROMPTS_FILE);           // { style: {...}, items: { "42": { prompt, digits? } } }
const STYLE = PROMPTS.style || {};
const ITEMS = PROMPTS.items || {};

/* 두 파일이 따로 관리되므로 어긋나면 바로 알려준다 */
{
  const noPrompt = Object.keys(PEGS).filter((k) => !ITEMS[k]?.prompt);
  const noLabel = Object.keys(ITEMS).filter((k) => !PEGS[k]);
  if (noPrompt.length) console.warn(`! prompts.json 에 없는 페그(건너뜀): ${noPrompt.join(", ")}`);
  if (noLabel.length) console.warn(`! pegs.json 에 없는 프롬프트(건너뜀): ${noLabel.join(", ")}`);
  if (!STYLE.base) console.warn("! prompts.json 의 style.base 가 비어 있습니다 — 항목 묘사만으로 생성합니다.");
}

const outPath = (key) => path.join(IMG_DIR, String(key.length), `${key}.${OPTS.format}`);
const buildPrompt = (key) => {
  const item = ITEMS[key];
  const figure = item.solemn ? STYLE.figureSolemn : STYLE.figure;           // 인물 톤: 야릇 / 엄숙
  const number = STYLE.number ? STYLE.number.replaceAll("{n}", key) : "";   // 카드에 찍히는 숫자
  const tail = item.digits ? STYLE.withDigits : STYLE.noText;
  return [item.prompt, STYLE.base, figure, number, tail].filter(Boolean).join(". ").replace(/\.\.+/g, ".");
};

/* 편집 지시문: 참조 그림이 화풍을 들고 있으니 덱 공통 문장은 붙이지 않고, 나머지는 그대로 두라고만 덧붙인다 */
const buildEditPrompt = (key) =>
  `${ITEMS[key].edit.trim().replace(/\.$/, "")}. Keep everything else in the picture exactly as it is: the same figure, pose, face, colours, `
  + `line style, border, background and the number banner at the bottom. No new text or numerals.`;
const refPath = (key) => {
  const item = ITEMS[key];
  if (item.ref) return path.resolve(ROOT, item.ref);
  const own = path.join(REF_DIR, `${key}.webp`);
  return fs.existsSync(own) ? own : outPath(key);
};

/* ── 편집용 참조 이미지·마스크 ────────────────────────────── */
const HAS_DWEBP = spawnSync("dwebp", ["-version"], { stdio: "ignore" }).status === 0;

/* 참조 이미지를 PNG 바이트로 (webp 는 dwebp 로 변환) */
function refPng(key) {
  const src = refPath(key);
  if (/\.png$/i.test(src)) return fs.readFileSync(src);
  if (!HAS_DWEBP) throw new Error("dwebp 가 없어 webp 참조 이미지를 변환하지 못합니다 (apt install webp)");
  const tmp = path.join(os.tmpdir(), `peg-ref-${key}-${process.pid}.png`);
  const r = spawnSync("dwebp", [src, "-quiet", "-o", tmp], { stdio: "ignore" });
  if (r.status !== 0 || !fs.existsSync(tmp)) throw new Error(`참조 이미지 변환 실패: ${path.relative(ROOT, src)}`);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf;
}
const pngSize = (png) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

/* 최소 PNG 인코더: RGBA, 무필터. 마스크 한 장 만드는 데 라이브러리까지 쓸 필요는 없다 */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/* 마스크: 투명(alpha 0)한 곳만 다시 그려지고, 불투명한 곳은 원본 픽셀이 남는다 */
function maskPng(w, h, m) {
  const x0 = Math.max(0, Math.floor(w * m.x)), y0 = Math.max(0, Math.floor(h * m.y));
  const x1 = Math.min(w, Math.ceil(w * (m.x + m.w))), y1 = Math.min(h, Math.ceil(h * (m.y + m.h)));
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const keep = !(x >= x0 && x < x1 && y >= y0 && y < y1);
      raw.set([0, 0, 0, keep ? 255 : 0], row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

let targets = Object.keys(PEGS)
  .filter((k) => ITEMS[k]?.prompt)
  .sort((a, b) => a.length - b.length || a.localeCompare(b));
if (OPTS.only.length) {
  const unknown = OPTS.only.filter((k) => !PEGS[k]);
  if (unknown.length) {
    console.error(`알 수 없는 키: ${unknown.join(", ")}`);
    process.exit(1);
  }
  targets = OPTS.only;
}
if (OPTS.edit) {
  const noEdit = targets.filter((k) => !ITEMS[k]?.edit);
  if (noEdit.length) {
    console.error(`편집 지시(edit)가 없는 키: ${noEdit.join(", ")} — prompts.json 의 해당 항목에 "edit" 를 적어 주세요.`);
    process.exit(1);
  }
  const noRef = targets.filter((k) => !fs.existsSync(refPath(k)));
  if (noRef.length) {
    console.error(`참조 이미지가 없는 키: ${noRef.join(", ")}`);
    process.exit(1);
  }
} else if (!OPTS.force) targets = targets.filter((k) => !fs.existsSync(outPath(k)));

if (OPTS.listMissing) {
  console.log(targets.join("\n"));
  console.log(`\n남은 개수: ${targets.length}`);
  process.exit(0);
}

if (OPTS.dryRun) {
  for (const key of targets) {
    if (OPTS.edit) {
      const m = ITEMS[key].editMask;
      console.log(`\n[${key}] ${PEGS[key]}  (편집)  참조: ${path.relative(ROOT, refPath(key))}`
        + (m ? `  마스크: x${m.x} y${m.y} w${m.w} h${m.h}` : "  마스크 없음(전체)"));
      console.log(buildEditPrompt(key));
      if (m) {  /* 마스크가 맞게 잡혔는지 눈으로 확인할 수 있게 파일로 남긴다 */
        const png = refPng(key), { w, h } = pngSize(png);
        const out = path.join(os.tmpdir(), `peg-mask-${key}.png`);
        fs.writeFileSync(out, maskPng(w, h, m));
        console.log(`마스크 미리보기: ${out} (${w}x${h}, 투명한 곳만 다시 그림)`);
      }
    } else console.log(`\n[${key}] ${PEGS[key]}\n${buildPrompt(key)}`);
  }
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

/* ── 축소 (cwebp) ─────────────────────────────────────────── */
const HAS_CWEBP = spawnSync("cwebp", ["-version"], { stdio: "ignore" }).status === 0;
const WILL_SHRINK = HAS_CWEBP && OPTS.maxWidth > 0 && OPTS.format === "webp";
if (!HAS_CWEBP && OPTS.maxWidth > 0 && OPTS.format === "webp") {
  console.warn("! cwebp 가 없어 축소를 건너뜁니다 — 장당 수백 KB 로 저장됩니다. (brew/apt install webp)");
}

/* API 가 준 파일을 maxWidth 로 줄여 제자리에 덮어쓴다. 실패하면 원본을 그대로 둔다. */
function shrink(file) {
  if (!WILL_SHRINK) return false;
  const tmp = `${file}.tmp`;
  const r = spawnSync("cwebp", ["-quiet", "-q", String(OPTS.webpQuality), "-resize", String(OPTS.maxWidth), "0",
                                "-metadata", "none", file, "-o", tmp], { stdio: "ignore" });
  if (r.status === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
    fs.renameSync(tmp, file);
    return true;
  }
  try { fs.unlinkSync(tmp); } catch {}
  console.warn(`  · ${path.relative(ROOT, file)} 축소 실패 — 원본 크기로 둡니다.`);
  return false;
}

/* ── API 호출 ─────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 모델·파라미터 지원 범위는 계정과 모델 세대마다 달라서, 서버가 거부하면 깎아내며 재시도한다 */
let model = OPTS.model;
const dropped = new Set();

function body(key) {
  const b = {
    model,
    prompt: buildPrompt(key),
    n: 1,
    size: OPTS.size,
    quality: OPTS.quality,
    output_format: OPTS.format,
    moderation: "low",
  };
  /* webp/jpeg 는 API 단에서도 손실 압축을 걸 수 있다 (기본은 사실상 무손실이라 2MB+) */
  if (OPTS.format !== "png") b.output_compression = 85;
  for (const k of dropped) delete b[k];
  return b;
}

/* 편집 요청은 multipart: 참조 이미지(+마스크)를 파일로 올린다 */
function editForm(key) {
  const png = refPng(key);
  const { w, h } = pngSize(png);
  const fields = {
    model,
    prompt: buildEditPrompt(key),
    n: "1",
    size: OPTS.size,
    quality: OPTS.quality,
    output_format: OPTS.format,
    moderation: "low",
    input_fidelity: "high",          // 얼굴·세부를 최대한 지킨다 (미지원 모델이면 자동 제외)
  };
  if (OPTS.format !== "png") fields.output_compression = "85";
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (!dropped.has(k)) fd.append(k, String(v));
  fd.append("image", new Blob([png], { type: "image/png" }), `${key}.png`);
  const m = ITEMS[key].editMask;
  if (m) fd.append("mask", new Blob([maskPng(w, h, m)], { type: "image/png" }), `${key}-mask.png`);
  return fd;
}

async function generate(key) {
  const MAX = 6;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let res, text;
    try {
      res = OPTS.edit
        ? await fetch(EDIT_ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${API_KEY}` }, body: editForm(key) })
        : await fetch(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
            body: JSON.stringify(body(key)),
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
      shrink(file);
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
console.log(`모델 ${model} / ${OPTS.size} / quality=${OPTS.quality} / ${OPTS.format} / 동시 ${OPTS.concurrency}`
  + (WILL_SHRINK ? ` / cwebp ${OPTS.maxWidth}px q${OPTS.webpQuality}` : ""));
console.log(OPTS.edit
  ? `편집 대상 ${targets.length}개 (참조 이미지를 고쳐 기존 카드를 덮어씀)\n`
  : `생성 대상 ${targets.length}개${OPTS.force ? " (--force)" : " (기존 파일은 건너뜀)"}\n`);
if (!targets.length) { console.log("만들 것이 없습니다. 끝."); process.exit(0); }

const failed = [];
let done = 0;
const queue = [...targets];

async function worker() {
  while (queue.length) {
    const key = queue.shift();
    const label = PEGS[key];
    try {
      const file = await generate(key);
      done++;
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log(`✔ [${String(done).padStart(3)}/${targets.length}] ${key.padEnd(2)} ${label} → ${path.relative(ROOT, file)} (${kb} KB)`);
    } catch (err) {
      failed.push({ key, label, reason: String(err.message || err) });
      console.error(`✘ ${key} ${label} — ${err.message || err}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(OPTS.concurrency, targets.length) }, worker));

console.log(`\n완료: ${done}개 성공, ${failed.length}개 실패`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.key} ${f.label}: ${f.reason}`);
  console.log(`\n실패분만 다시: node tools/gen-peg-images.mjs${OPTS.edit ? " --edit" : ""} --only ${failed.map((f) => f.key).join(",")}`);
  console.log("SAFETY 로 거부된 항목은 docs/data/prompts.json 의 prompt 를 순화한 뒤 다시 돌리면 됩니다.");
  process.exit(1);
}
