#!/usr/bin/env node
/**
 * rename-exams.js — raw/ 폴더의 PDF를 분석해 exams/ 로 자동 분류
 *
 * 사용법:
 *   npm install                    # 최초 1회
 *   node rename-exams.js           # 실행
 *   node rename-exams.js --dry-run # 이동 없이 미리보기
 *   node rename-exams.js --verbose # 추출 텍스트 함께 출력
 *
 * 출력 경로 형식:
 *   exams/{연도}/{학기}/{차수}/{학년}-{과목}.pdf
 *   예) exams/2024/2학기/2차/2학년-수학.pdf
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

// ── 의존 모듈 확인 ────────────────────────────────────────────────────────
let pdfParse;
try { pdfParse = require('pdf-parse'); }
catch {
  console.error([
    '',
    '❌  pdf-parse 모듈이 없습니다. 먼저 설치해주세요:',
    '',
    '       npm install',
    '',
  ].join('\n'));
  process.exit(1);
}

// ── 경로 / CLI 옵션 ───────────────────────────────────────────────────────
const ROOT     = __dirname;
const RAW      = path.join(ROOT, 'raw');
const EXAMS    = path.join(ROOT, 'exams');
const UNKNOWN  = path.join(ROOT, 'unknown');

const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

// ── ANSI 색상 ─────────────────────────────────────────────────────────────
const p = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const ok   = s => p('32', s);
const warn = s => p('33', s);
const bad  = s => p('31', s);
const dim  = s => p('2',  s);
const bold = s => p('1',  s);
const cyan = s => p('36', s);

// ── 과목 목록 (구체적인 것 → 짧은 것 순서로 나열해 최장 일치 우선) ──────
const SUBJECT_KEYS = [
  '화법과작문', '언어와매체',
  '생활과윤리', '윤리와사상',
  '확률과통계',
  '동아시아사',
  '과학탐구실험', '통합과학',
  '생명과학', '지구과학', '물리학',
  '기술가정',
  '세계지리', '한국지리',
  '사회문화', '정치와법',
  '세계사', '한국사',
  '독서', '문학',
  '미적분', '기하',
  '경제', '정보',
  // 짧은 단어는 마지막에 (부분 일치 방지)
  '수학', '국어', '영어', '사회', '화학', '과학',
  '체육', '음악', '미술', '도덕', '역사',
];

// ── 텍스트 정규화 ─────────────────────────────────────────────────────────
function normalize(raw) {
  return raw
    .replace(/\s+/g, '')
    .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲ]/g, ch => ({
      'Ⅰ':'I','Ⅱ':'II','Ⅲ':'III','Ⅳ':'IV','Ⅴ':'V',
      'Ⅵ':'VI','Ⅶ':'VII','Ⅷ':'VIII','Ⅸ':'IX','Ⅹ':'X',
      'ⅰ':'I','ⅱ':'II','ⅲ':'III',
    }[ch] || ch))
    .replace(/[·•‧・]/g, '')
    .replace(/（/g, '(').replace(/）/g, ')');
}

// ── 파싱 함수 ─────────────────────────────────────────────────────────────
function parseYear(t) {
  const m = t.match(/20[2-3]\d/);
  return m ? m[0] : null;
}

function parseSemester(t) {
  if (/1학기/.test(t)) return '1학기';
  if (/2학기/.test(t)) return '2학기';
  // 중간/기말은 학기 정보 없이 차수만 알 수 있으므로 null
  return null;
}

function parseExamType(t) {
  // 1차 패턴: 1차지필, 1차정기, 중간고사
  if (/1차정기고사|제1차정기|1차정기|1차지필|중간고사/.test(t)) return '1차';
  // 2차 패턴: 2차지필, 2차정기, 기말고사
  if (/2차정기고사|제2차정기|2차정기|2차지필|기말고사/.test(t)) return '2차';
  return null;
}

function parseGrade(t) {
  let m = t.match(/(?<!\d)([1-3])학년(?!도)/);
  if (m) return `${m[1]}학년`;
  m = t.match(/고([1-3])(?!\d)/);
  if (m) return `${m[1]}학년`;
  return null;
}

function parseSubject(t) {
  for (const key of SUBJECT_KEYS) {
    const idx = t.indexOf(key);
    if (idx === -1) continue;

    const tail = t.slice(idx + key.length, idx + key.length + 3);
    if (/^III/.test(tail))                return key + 'Ⅲ';
    if (/^II/.test(tail))                 return key + 'Ⅱ';
    if (/^I[^A-Z가-힣]/.test(tail + ' ')) return key + 'Ⅰ';
    return key;
  }
  return null;
}

// ── 파일명 기반 파싱 (텍스트 레이어 없을 때 fallback) ────────────────────
function parseFromFilename(filepath) {
  const filename = path.basename(filepath, '.pdf');
  const dirName  = path.basename(path.dirname(filepath));
  // 폴더명 + 파일명을 합쳐서 파싱 (폴더에 학기/차수 정보가 있을 수 있음)
  const combined = dirName + ' ' + filename;
  const norm     = normalize(combined);

  const isInfo   = /문항정보표/.test(norm);
  const year     = parseYear(norm);
  const grade    = parseGrade(combined);     // 공백 보존 (연도 숫자 분리 유지)
  const semester = parseSemester(combined);  // "1학기"/"2학기" 추출
  const examType = parseExamType(norm);

  // 과목 추출 우선순위:
  // 1) 괄호 안 — "(과목명)" 스타일
  let subject = null;
  const groups = filename.match(/[（(]([^)）]+)[）)]/g);
  if (groups) {
    const inner = groups[groups.length - 1].replace(/^[（(]|[）)]$/g, '').trim();
    subject = parseSubject(normalize(inner)) || inner;
  }

  // 2) 대시 뒤 — "... - 과목" 또는 "...-과목" 스타일 (2024 형식)
  if (!subject) {
    const afterDash = filename.match(/[-–]\s*([가-힣]{2,8})\s*$/);
    if (afterDash) {
      subject = parseSubject(normalize(afterDash[1])) || afterDash[1].trim();
    }
  }

  // 3) 정규화된 파일명 전체 스캔
  if (!subject) {
    subject = parseSubject(normalize(filename));
  }

  return { year, semester, grade, examType, subject, isInfo };
}

// ── 파일 유틸 ─────────────────────────────────────────────────────────────
function mkdir(dir) {
  if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true });
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

function mv(src, dest) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');

// ── PDF 수집 (raw/ 재귀 탐색) ─────────────────────────────────────────────
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

// ── 메인 ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log(bold('기출문제 PDF 자동 분류'));
  console.log(dim('  출력 경로: exams/{연도}/{학기}/{차수}/{학년}-{과목}.pdf'));
  if (DRY_RUN) console.log(warn('  ⚑ dry-run 모드 — 실제로 파일을 이동하지 않습니다'));
  console.log('');

  if (!fs.existsSync(RAW)) {
    mkdir(RAW);
    console.log(warn('raw/ 폴더가 없어 새로 만들었습니다.'));
    console.log(dim('PDF 파일을 raw/ 에 넣고 다시 실행하세요.\n'));
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
    const src  = pdfs[i];
    const name = path.basename(src);
    const tag  = dim(`[${String(i + 1).padStart(w)}/${pdfs.length}]`);

    console.log(`${tag} ${bold(name)}`);

    // ── 텍스트 추출 ───────────────────────────────────────────────────────
    let rawText = '';
    try {
      const buf  = fs.readFileSync(src);
      const data = await pdfParse(buf, { max: 1 });
      rawText = (data.text || '').trim();
    } catch (e) {
      const reason = `PDF 읽기 실패: ${e.message}`;
      console.log(`     ${bad('✗')} ${reason}`);
      const dest = uniqueDest(UNKNOWN, name);
      mkdir(UNKNOWN);
      mv(src, dest);
      unknown.push({ name, src, dest, reason });
      continue;
    }

    if (!rawText) {
      console.log(`     ${warn('!')} 텍스트 레이어 없음 — 파일명으로 파싱 시도`);

      const { year: fy, semester: fsem, grade: fg, examType: fe, subject: fs, isInfo } =
        parseFromFilename(src);

      if (VERBOSE) {
        console.log(dim(`     파일명 파싱: 연도=${fy ?? '-'}  학기=${fsem ?? '-'}  시험=${fe ?? '-'}  학년=${fg ?? '-'}  과목=${fs ?? '-'}  문항정보표=${isInfo}`));
      }

      if (isInfo && fy) {
        const destDir  = path.join(EXAMS, fy, '문항정보표');
        const destName = (fg && fs) ? `${fg}-${fs}.pdf` : name;
        const dest     = uniqueDest(destDir, destName);
        mkdir(destDir);
        mv(src, dest);
        console.log(`     ${ok('✓')} → ${cyan(rel(dest))}  ${dim('(파일명 기반)')}`);
        moved.push({ name, dest });
      } else if (fy && fsem && fe && fg && fs) {
        const destDir  = path.join(EXAMS, fy, fsem, fe);
        const destName = `${fg}-${fs}.pdf`;
        const dest     = uniqueDest(destDir, destName);
        mkdir(destDir);
        mv(src, dest);
        console.log(`     ${ok('✓')} → ${cyan(rel(dest))}  ${dim('(파일명 기반)')}`);
        moved.push({ name, dest });
      } else {
        const missing = [
          fy   ? null : '연도',
          fsem ? null : '학기',
          fe   ? null : '차수',
          fg   ? null : '학년',
          fs   ? null : '과목',
        ].filter(Boolean);
        const reason = `텍스트 레이어 없음, 파일명 파싱 미검출: ${missing.join(', ')}`;
        const dest   = uniqueDest(UNKNOWN, name);
        mkdir(UNKNOWN);
        mv(src, dest);
        console.log(`     ${warn('?')} → ${warn(rel(dest))}  ${dim('(' + reason + ')')}`);
        unknown.push({ name, src, dest, reason });
      }
      continue;
    }

    // ── 메타 파싱 (텍스트 레이어 있는 경우) ──────────────────────────────
    const norm     = normalize(rawText);
    const year     = parseYear(norm);
    const semester = parseSemester(norm);
    const examType = parseExamType(norm);
    const grade    = parseGrade(norm);
    const subject  = parseSubject(norm);

    if (VERBOSE) {
      console.log(dim(`     텍스트: ${norm.slice(0, 200)}`));
      console.log(dim(`     파싱  : 연도=${year ?? '-'}  학기=${semester ?? '-'}  차수=${examType ?? '-'}  학년=${grade ?? '-'}  과목=${subject ?? '-'}`));
    }

    const missing = [
      year     ? null : '연도',
      semester ? null : '학기',
      examType ? null : '차수',
      grade    ? null : '학년',
      subject  ? null : '과목',
    ].filter(Boolean);

    if (missing.length === 0) {
      const destDir  = path.join(EXAMS, year, semester, examType);
      const destName = `${grade}-${subject}.pdf`;
      const dest     = uniqueDest(destDir, destName);
      mkdir(destDir);
      mv(src, dest);
      console.log(`     ${ok('✓')} → ${cyan(rel(dest))}`);
      moved.push({ name, dest });
    } else {
      const reason = `미검출: ${missing.join(', ')}`;
      const dest   = uniqueDest(UNKNOWN, name);
      mkdir(UNKNOWN);
      mv(src, dest);
      console.log(`     ${warn('?')} → ${warn(rel(dest))}  ${dim('(' + reason + ')')}`);
      if (!VERBOSE) {
        console.log(dim(`     힌트: ${norm.slice(0, 120)}`));
      }
      unknown.push({ name, src, dest, reason, hint: norm.slice(0, 200) });
    }
  }

  // ── 요약 ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(bold('── 결과 요약 ─────────────────────────────────────'));
  console.log(`  ${ok('✓ 분류 완료')}  ${bold(String(moved.length))}개`);
  if (unknown.length > 0) {
    console.log(`  ${warn('? 미분류   ')}  ${bold(String(unknown.length))}개  → unknown/ 폴더`);
  }

  if (unknown.length > 0) {
    console.log('');
    console.log(warn('미분류 파일 목록:'));
    unknown.forEach(({ name, reason }) => {
      console.log(`  ${bad('✗')} ${name}`);
      console.log(`    ${dim(reason)}`);
    });
    console.log('');
    console.log(dim('  파일명 또는 내용을 확인 후 직접 경로를 지정하거나,'));
    console.log(dim('  exams/{연도}/{학기}/{차수}/{학년}-{과목}.pdf 위치로 수동 이동하세요.'));
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

main().catch(e => {
  console.error(bad('\n오류:'), e.message);
  process.exit(1);
});
