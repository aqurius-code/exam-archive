#!/usr/bin/env node
/**
 * 사용법: node generate-exam-list.js
 *
 * exams/ 폴더를 순회해 exam-list.json 을 생성합니다.
 * PDF 파일을 추가하거나 삭제할 때마다 실행하세요.
 *
 * 필수 폴더 구조:
 *   exams/{연도}/{학기}/{차수}/{학년}-{과목}.pdf
 *
 * 예시:
 *   exams/2024/1학기/1차/2학년-수학.pdf
 *   exams/2024/2학기/2차/3학년-영어.pdf
 */

const fs   = require('fs');
const path = require('path');

const EXAMS_DIR = path.join(__dirname, 'exams');
const OUT_FILE  = path.join(__dirname, 'exam-list.json');

if (!fs.existsSync(EXAMS_DIR)) {
  console.error('❌ exams/ 폴더가 없습니다. 먼저 폴더를 만들어주세요.');
  process.exit(1);
}

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.name.toLowerCase().endsWith('.pdf')) {
      const rel   = path.relative(EXAMS_DIR, full);
      const parts = rel.split(path.sep);

      // 정규 시험: exams/{연도}/{학기}/{차수}/{학년}-{과목}.pdf (4단계)
      if (parts.length === 4) {
        const [year, semester, examType, filename] = parts;
        const base = path.basename(filename, '.pdf');
        const dash = base.indexOf('-');

        if (dash === -1) {
          console.warn(`  [건너뜀] "학년-과목" 형식이 아닙니다: ${filename}`);
          continue;
        }

        const grade   = base.slice(0, dash);
        const subject = base.slice(dash + 1);

        acc.push({
          path: 'exams/' + parts.join('/'),
          year,
          semester,
          examType,
          grade,
          subject,
        });

      // 문항정보표: exams/{연도}/문항정보표/{파일}.pdf (3단계) — 목록에서 제외
      } else if (parts.length === 3 && parts[1] === '문항정보표') {
        // 시험지가 아니므로 exam-list.json 에 포함하지 않음

      } else {
        console.warn(`  [건너뜀] 예상과 다른 경로 (${parts.length}단계): ${rel}`);
      }
    }
  }
  return acc;
}

const exams = walk(EXAMS_DIR);

// 연도 내림차순 → 학기 → 차수 → 학년 → 과목 순 정렬
exams.sort((a, b) => {
  if (a.year     !== b.year)     return b.year.localeCompare(a.year);
  if (a.semester !== b.semester) return a.semester.localeCompare(b.semester);
  if (a.examType !== b.examType) return a.examType.localeCompare(b.examType);
  if (a.grade    !== b.grade)    return a.grade.localeCompare(b.grade);
  return a.subject.localeCompare(b.subject);
});

fs.writeFileSync(OUT_FILE, JSON.stringify(exams, null, 2), 'utf8');

console.log(`\n✅ exam-list.json 생성 완료 (${exams.length}개)\n`);

if (exams.length === 0) {
  console.log('  아직 PDF 파일이 없습니다.');
  console.log('  exams/{연도}/{학기}/{차수}/{학년}-{과목}.pdf 형식으로 추가해주세요.');
} else {
  const tree = {};
  exams.forEach(e => {
    tree[e.year] ??= {};
    tree[e.year][e.semester] ??= {};
    tree[e.year][e.semester][e.examType] ??= [];
    tree[e.year][e.semester][e.examType].push(`${e.grade} ${e.subject}`);
  });

  Object.keys(tree).sort((a, b) => b.localeCompare(a)).forEach(year => {
    console.log(`  ${year}`);
    Object.keys(tree[year]).sort().forEach(sem => {
      console.log(`    ${sem}`);
      Object.keys(tree[year][sem]).sort().forEach(type => {
        console.log(`      ${type}`);
        tree[year][sem][type].forEach(item => console.log(`        - ${item}`));
      });
    });
  });
}
