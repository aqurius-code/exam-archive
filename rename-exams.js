#!/usr/bin/env node
/**
 * rename-exams.js — raw/ 폴더 경로 기반으로 PDF를 exams/ 로 분류
 *
 * 사용법:
 *   node rename-exams.js           # 실행
 *   node rename-exams.js --dry-run # 이동 없이 미리보기
 *   node rename-exams.js --verbose # 파싱 상세 출력
 *
 * 입력 폴더 구조 (권장):
 *   raw/{연도}/{학년}/{학기}/{시험종류}/{파일명}.pdf
 *   예) raw/2024/2학년/1학기/1차지필/국어.pdf
 *       raw/2025/3학년/1학기/2차지필평가/원안지(과학).pdf
 *
 * 출력 경로:
 *   exams/{연도}/{학기}/{차수}/{학년}-{과목}.pdf
 *   예) exams/2024/1학기/1차/2학년-국어.pdf
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = __dirname;
const RAW     = path.join(ROOT, 'raw');
const EXAMS   = path.join(ROOT, 'exams');
const UNKNOWN = path.join(ROOT, 'unknown');

const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

// ── ANSI 색상 ─────────────────────────────────────────────────────────────────
const p    = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const ok   = s => p('32', s);
const warn = s => p('33', s);
const bad  = s => p('31', s);
const dim  = s => p('2',  s);
const bold = s => p('1',  s);
const cyan = s => p('36', s);

// ── 시험 차수 정규화 ──────────────────────────────────────────────────────────
const EXAM_TYPE_MAP = [
  [/2차\s*지필평가|2차\s*정기고사|2차\s*정기시험|2차\s*정기|2차\s*지필|기말고사/i, '2차'],
  [/1차\s*지필평가|1차\s*정기고사|1차\s*정기시험|1차\s*정기|1차\s*지필|중간고사/i, '1차'],
];

function normalizeExamType(raw) {
  for (const [re, out] of EXAM_TYPE_MAP) {
    if (re.test(raw)) return out;
  }
  return null;
}

// ── 과목 목록 (긴 것 → 짧은 것 순서) ─────────────────────────────────────────
const SUBJECT_KEYS = [
  '화법과작문', '언어와매체', '생활과윤리', '윤리와사상', '확률과통계',
  '동아시아사', '과학탐구실험', '통합과학', '생명과학', '지구과학', '물리학',
  '기술가정', '세계지리', '한국지리', '사회문화', '정치와법', '세계사', '한국사',
  '독서', '문학', '미적분', '기하', '경제', '정보',
  '수학', '국어', '영어', '사회', '화학', '과학', '체육', '음악', '미술', '도덕', '역사',
];

function matchSubject(text) {
  const norm = text.replace(/\s+/g, '');
  for (const key of SUBJECT_KEYS) {
    if (norm.includes(key)) return key;
  }
  return null;
}

// ── 파일명에서 과목 추출 ──────────────────────────────────────────────────────
function subjectFromFilename(filename) {
  const base = path.basename(filename, '.pdf');

  // 1) 괄호 안: 원안지(과학) → 과학
  const bracketMatch = base.match(/[（(]([^）)]+)[）)]/);
  if (bracketMatch) {
    const inner = bracketMatch[1].trim();
    const s = matchSubject(inner);
    if (s) return s;
    if (/^[가-힣]{2,6}$/.test(inner)) return inner;
  }

  // 2) 파일 기본명 전체 스캔
  const s = matchSubject(base);
  if (s) return s;

  // 3) 순수 한글 2~6자 기본명
  const clean = base.replace(/\s+/g, '');
  if (/^[가-힣]{2,6}$/.test(clean)) return clean;

  return null;
}

// ── 정규화 헬퍼 ───────────────────────────────────────────────────────────────
function normalizeYear(raw) {
  const m = raw.match(/20[2-3]\d/);
  return m ? m[0] : null;
}

function normalizeGrade(raw) {
  const m = raw.match(/([1-3])학년/);
  if (m) return `${m[1]}학년`;
  return null;
}

function normalizeSemester(raw) {
  if (/1학기/.test(raw)) return '1학기';
  if (/2학기/.test(raw)) return '2학기';
  return null;
}

// ── 경로 기반 파싱 ───────────────────────────────────────────────────────────
// raw/ 기준 상대경로 파트: [year, grade, semester, examType, filename]
function parseFromPath(relParts, filename) {
  if (relParts.length < 4) return null;
  return {
    year:     normalizeYear(relParts[0]),
    grade:    normalizeGrade(relParts[1]),
    semester: normalizeSemester(relParts[2]),
    examType: normalizeExamType(relParts[3]),
    subject:  subjectFromFilename(filename),
    source:   'path',
  };
}

// ── 파일명 기반 파싱 (fallback) ──────────────────────────────────────────────
function parseFromFilenameOnly(filename) {
  const base = path.basename(filename, '.pdf');
  let examType = null;
  for (const [re, out] of EXAM_TYPE_MAP) {
    if (re.test(base)) { examType = out; break; }
  }
  return {
    year:     normalizeYear(base),
    grade:    normalizeGrade(base),
    semester: normalizeSemester(base),
    examType,
    subject:  subjectFromFilename(filename),
    source:   'filename',
  };
}

// ── 파일 유틸 ─────────────────────────────────────────────────────────────────
function mv(src, dest) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext  = path.extname(name);
  const base = path.basename(name, ext);
  for (let n = 2; n < 1000; n++) {
    dest = path.join(dir, `${base}-${n}${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
  return dest;
}

const relPath = f => path.relative(ROOT, f).replace(/\\/g, '/');

function collectPDFs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory())             out.push(...collectPDFs(full));
    else if (/\.pdf$/i.test(e.name)) out.push(full);
  }
  return out;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
function main() {
  console.log('');
  console.log(bold('기출문제 PDF 자동 분류 (폴더 경로 기반)'));
  console.log(dim('  입력: raw/{연도}/{학년}/{학기}/{시험종류}/{과목}.pdf'));
  console.log(dim('  출력: exams/{연도}/{학기}/{차수}/{학년}-{과목}.pdf'));
  if (DRY_RUN) console.log(warn('  ⚑ dry-run 모드 — 파일을 실제로 이동하지 않습니다'));
  console.log('');

  // ── Step 1: unknown/ 파일을 raw/ 로 되돌려 재분류 ───────────────────────
  const unknownPDFs = collectPDFs(UNKNOWN);
  if (unknownPDFs.length > 0) {
    console.log(dim(`unknown/ 파일 ${unknownPDFs.length}개를 raw/ 로 이동 중…`));
    if (!DRY_RUN) fs.mkdirSync(RAW, { recursive: true });
    for (const src of unknownPDFs) {
      const dest = uniqueDest(RAW, path.basename(src));
      mv(src, dest);
      console.log(`  ${dim('↩')} ${path.basename(src)}`);
    }
    console.log('');
  }

  if (!fs.existsSync(RAW)) {
    if (!DRY_RUN) fs.mkdirSync(RAW, { recursive: true });
    console.log(warn('raw/ 폴더가 없어 새로 만들었습니다.'));
    console.log(dim('PDF 파일을 raw/{연도}/{학년}/{학기}/{시험종류}/ 폴더 구조로 넣고 다시 실행하세요.\n'));
    return;
  }

  const pdfs = collectPDFs(RAW);
  if (pdfs.length === 0) {
    console.log(warn('raw/ 폴더에 PDF 파일이 없습니다.\n'));
    return;
  }

  const w = pdfs.length.toString().length;
  console.log(dim(`raw/ 에서 ${pdfs.length}개 발견\n`));

  const moved   = [];
  const unknown = [];

  for (let i = 0; i < pdfs.length; i++) {
    const src      = pdfs[i];
    const filename = path.basename(src);
    const rel      = path.relative(RAW, src);
    const parts    = rel.split(path.sep);
    const tag      = dim(`[${String(i + 1).padStart(w)}/${pdfs.length}]`);

    console.log(`${tag} ${bold(filename)}`);
    if (VERBOSE) console.log(dim(`     경로: raw/${rel}`));

    // 경로 기반 파싱 시도 → 실패 시 파일명 기반 fallback
    let meta = parseFromPath(parts.slice(0, -1), filename);
    const { year: py, grade: pg, semester: ps, examType: pe, subject: psu } = meta || {};
    if (!meta || !(py && pg && ps && pe && psu)) {
      meta = parseFromFilenameOnly(filename);
    }

    const { year, grade, semester, examType, subject, source } = meta;

    if (VERBOSE) {
      console.log(dim(`     파싱(${source}): 연도=${year ?? '-'}  학년=${grade ?? '-'}  학기=${semester ?? '-'}  차수=${examType ?? '-'}  과목=${subject ?? '-'}`));
    }

    const missing = [
      year     ? null : '연도',
      grade    ? null : '학년',
      semester ? null : '학기',
      examType ? null : '차수',
      subject  ? null : '과목',
    ].filter(Boolean);

    if (missing.length === 0) {
      const destDir  = path.join(EXAMS, year, semester, examType);
      const destName = `${grade}-${subject}.pdf`;
      const dest     = uniqueDest(destDir, destName);
      mv(src, dest);
      const srcLabel = source === 'filename' ? dim('  (파일명 기반)') : '';
      console.log(`     ${ok('✓')} → ${cyan(relPath(dest))}${srcLabel}`);
      moved.push({ filename, dest });
    } else {
      const reason = `미검출: ${missing.join(', ')}`;
      const dest   = uniqueDest(UNKNOWN, filename);
      mv(src, dest);
      console.log(`     ${warn('?')} → ${warn(relPath(dest))}  ${dim('(' + reason + ')')}`);
      unknown.push({ filename, reason });
    }
  }

  // ── 요약 ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('── 결과 요약 ─────────────────────────────────────'));
  console.log(`  ${ok('✓ 분류 완료')}  ${bold(String(moved.length))}개`);
  if (unknown.length > 0) {
    console.log(`  ${warn('? 미분류   ')}  ${bold(String(unknown.length))}개  → unknown/ 폴더`);
    console.log('');
    console.log(warn('미분류 파일 — 폴더 구조 정리 후 재실행하세요:'));
    console.log(dim('  raw/{연도}/{학년}/{학기}/{시험종류}/파일명.pdf'));
    console.log('');
    unknown.forEach(({ filename, reason }) =>
      console.log(`  ${bad('✗')} ${filename}  ${dim('(' + reason + ')')}`)
    );
  }

  // ── generate-exam-list.js 자동 실행 ──────────────────────────────────────
  if (!DRY_RUN) {
    console.log('');
    console.log(dim('인덱스 갱신 중 (generate-exam-list.js)…'));
    try {
      const out = execSync(`node "${path.join(ROOT, 'generate-exam-list.js')}"`, {
        cwd: ROOT, encoding: 'utf8',
      });
      console.log(out.trimEnd());
    } catch (e) {
      console.log(bad('generate-exam-list.js 실행 실패:'), (e.stderr || e.message).trim());
    }
  } else {
    console.log('');
    console.log(dim('(dry-run 완료. 실제 실행 시 generate-exam-list.js 가 자동으로 갱신됩니다)'));
  }
  console.log('');
}

main();
