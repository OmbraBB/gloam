// 증분(incremental) vs 차등(differential) 백업 비교 — pgBackRest 용어 기준
// diff = 마지막 full 이후 바뀐 것, incr = 마지막 백업(종류 무관) 이후 바뀐 것
// 운영 DB 칸 = 데이터 블록(설명용 8개). 요일마다 바뀐 블록이 주황으로 표시된다.
const K = (p, sub, hl) => ({ p, sub, hl });
const BLOCKS = (changed, label) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((n) => K(`블록 ${n}`, changed.includes(n) ? label : '', changed.includes(n) ? 'write' : null));

ArchMotion.scenario({
  title: '증분 vs 차등 백업',
  summary: '같은 변경을 두고 차등(diff)과 증분(incr)이 무엇을 담는지, 복원할 때 몇 개가 필요한지, 중간 백업 하나가 깨지면 어떻게 되는지 나란히 비교합니다.',
  disclaimer: 'pgBackRest 용어 기준 · 블록 8개는 설명용 축소',
  width: 1160,
  height: 600,

  kindNames: { ro: '백업 데이터', repl: '복원', ctrl: '제어' },

  groups: [
    { label: '운영 DB', x: 40, y: 190, w: 340, h: 230, tone: 'db' },
    { label: '백업 저장소', x: 430, y: 60, w: 540, h: 490, tone: 'store' },
    { label: '복구', x: 985, y: 220, w: 170, h: 170, tone: 'db' },
  ],

  nodes: [
    {
      id: 'db', label: '데이터 블록', sub: '오늘 바뀐 블록 = 주황', x: 210, y: 305, w: 300, h: 190, kind: 'db',
      slots: { cols: 4, w: 56, h: 44 },
      role: '운영 DB의 데이터 블록입니다. 요일마다 일부 블록만 바뀝니다. 백업 도구는 무엇이 바뀌었는지 비교해 필요한 것만 복사합니다.',
      details: [
        ['비교 단위', 'pgBackRest 기본 = 파일(바뀐 파일 전체), repo-block = 블록'],
        ['PG17 내장', 'WAL summary로 바뀐 블록 판별'],
      ],
    },
    {
      id: 'diff', label: '차등 백업 체인', sub: 'diff = 마지막 full 이후 변경 전부', x: 700, y: 175, w: 500, h: 130, kind: 'store',
      slots: { cols: 4, w: 108, h: 50, empty: '—' },
      role: '매번 "마지막 full 이후 바뀐 것 전부"를 담습니다. 날이 갈수록 커지지만 각 diff는 full 하나에만 기댑니다.',
      details: [
        ['기준', '항상 마지막 full'],
        ['크기', '요일이 지날수록 누적해서 커짐'],
        ['복원에 필요', 'full + 원하는 diff 1개'],
      ],
      notes: ['같은 블록이 여러 번 바뀌어도 diff에는 최신본 한 벌만 들어갑니다(블록 2 참고).'],
    },
    {
      id: 'incr', label: '증분 백업 체인', sub: 'incr = 직전 백업 이후 변경만', x: 700, y: 440, w: 500, h: 130, kind: 'store',
      slots: { cols: 4, w: 108, h: 50, empty: '—' },
      role: '매번 "직전 백업 이후 바뀐 것"만 담습니다. 가장 작고 빠르지만, 복원하려면 full부터 그날까지의 모든 incr가 이어져 있어야 합니다.',
      details: [
        ['기준', '직전 백업 (full·diff·incr 무엇이든)'],
        ['크기', '그날 변경량만큼, 일정함'],
        ['복원에 필요', 'full + 사이의 incr 전부'],
      ],
      notes: [
        'PG17 pg_basebackup --incremental은 기준 manifest를 무엇으로 주느냐에 따라 달라집니다. 매번 full의 manifest를 주면 차등처럼, 직전 백업의 manifest를 주면 증분처럼 동작합니다.',
      ],
    },
    {
      id: 'restore', label: '복구 서버', sub: '수요일 시점으로', x: 1070, y: 305, w: 150, kind: 'db',
      role: '수요일 백업 시점으로 되돌리는 서버입니다. 백업을 풀어 합친 뒤 WAL로 원하는 시각까지 맞춥니다.',
      details: [['pgBackRest', 'restore --set=<백업 라벨>'], ['PG17 내장', 'pg_combinebackup으로 합친 뒤 복원']],
    },
  ],

  edges: [
    { id: 'db-diff', from: 'db', to: 'diff', kind: 'ro', fromSide: 'right', toSide: 'left', bend: -20 },
    { id: 'db-incr', from: 'db', to: 'incr', kind: 'ro', fromSide: 'right', toSide: 'left', bend: 20 },
    { id: 'diff-restore', from: 'diff', to: 'restore', kind: 'repl', fromSide: 'right', toSide: 'top', bend: -30, hidden: true },
    { id: 'incr-restore', from: 'incr', to: 'restore', kind: 'repl', fromSide: 'right', toSide: 'bottom', bend: 30, hidden: true },
  ],

  steps: [
    {
      title: '일요일: full 백업',
      note: '두 방식 모두 출발점은 full 백업입니다. 블록 8개를 전부 복사합니다.\n이후 월~수요일에 바뀌는 블록을 두 방식이 어떻게 담는지 비교합니다.',
      slots: {
        db: BLOCKS([], ''),
        diff: [K('full 일', '블록 8개 전부', 'load'), {}, {}, {}],
        incr: [K('full 일', '블록 8개 전부', 'load'), {}, {}, {}],
      },
      nodeNotes: { diff: 'full이 이후 모든 diff의 기준이 됩니다.', incr: 'full이 증분 체인의 첫 고리가 됩니다.' },
      flows: [{ edge: 'db-diff', rate: 1.6 }, { edge: 'db-incr', rate: 1.6 }],
    },
    {
      title: '월요일: 첫날은 같다',
      note: '월요일에 블록 2, 5가 바뀌었습니다.\ndiff(full 이후 변경)도, incr(직전 백업=full 이후 변경)도 블록 2, 5를 담습니다.\nfull 다음 첫 백업에서는 두 방식의 결과가 같습니다.',
      slots: {
        db: BLOCKS([2, 5], '월 변경'),
        diff: [K('full 일', '블록 8개 전부'), K('diff 월', '블록 2, 5', 'load'), {}, {}],
        incr: [K('full 일', '블록 8개 전부'), K('incr 월', '블록 2, 5', 'load'), {}, {}],
      },
      flows: [{ edge: 'db-diff', rate: 0.8 }, { edge: 'db-incr', rate: 0.8 }],
    },
    {
      title: '화요일: 차이가 생긴다',
      note: '화요일에는 블록 3, 7이 바뀌었습니다.\ndiff는 full 이후 바뀐 것 전부라 블록 2, 3, 5, 7을 담습니다(월요일 변경까지 다시).\nincr는 직전 백업(월요일) 이후 바뀐 블록 3, 7만 담습니다.',
      slots: {
        db: BLOCKS([3, 7], '화 변경'),
        diff: [K('full 일', '블록 8개 전부'), K('diff 월', '블록 2, 5'), K('diff 화', '블록 2, 3, 5, 7', 'load'), {}],
        incr: [K('full 일', '블록 8개 전부'), K('incr 월', '블록 2, 5'), K('incr 화', '블록 3, 7', 'load'), {}],
      },
      callouts: [
        { node: 'diff', text: '누적해서 커짐', tone: 'warn' },
        { node: 'incr', text: '그날 변경만', tone: 'ok', below: true },
      ],
      flows: [{ edge: 'db-diff', rate: 1.2 }, { edge: 'db-incr', rate: 0.8 }],
    },
    {
      title: '수요일: diff는 계속 커진다',
      note: '수요일에는 블록 2(다시), 8이 바뀌었습니다.\ndiff 수 = 블록 2, 3, 5, 7, 8. 블록 2는 두 번 바뀌었지만 최신본 한 벌만 들어갑니다.\nincr 수 = 블록 2, 8.\n저장 공간 합계: diff 체인은 2 + 4 + 5 = 11블록, incr 체인은 2 + 2 + 2 = 6블록.',
      slots: {
        db: BLOCKS([2, 8], '수 변경'),
        diff: [K('full 일', '블록 8개 전부'), K('diff 월', '블록 2, 5'), K('diff 화', '블록 2, 3, 5, 7'), K('diff 수', '블록 2, 3, 5, 7, 8', 'load')],
        incr: [K('full 일', '블록 8개 전부'), K('incr 월', '블록 2, 5'), K('incr 화', '블록 3, 7'), K('incr 수', '블록 2, 8', 'load')],
      },
      callouts: [
        { node: 'diff', text: '백업 시간·용량 ↑', tone: 'warn' },
        { node: 'incr', text: '백업 시간·용량 최소', tone: 'ok', below: true },
      ],
      flows: [{ edge: 'db-diff', rate: 1.4 }, { edge: 'db-incr', rate: 0.8 }],
    },
    {
      title: '복원: 필요한 개수가 다르다',
      note: '수요일 시점으로 복원합니다.\n차등: full 일 + diff 수, 2개면 됩니다.\n증분: full 일 + incr 월 + incr 화 + incr 수, 4개를 차례로 겹쳐야 합니다.\n백업할 때 아낀 시간을 복원할 때 갚는 구조입니다. 체인이 길수록 복원이 느려지고 확인할 것이 늘어납니다.',
      edges: { 'diff-restore': 'on', 'incr-restore': 'on' },
      states: { restore: 'recovering' },
      slots: {
        db: BLOCKS([], ''),
        diff: [K('full 일', '필요', 'hit'), K('diff 월', '불필요'), K('diff 화', '불필요'), K('diff 수', '필요', 'hit')],
        incr: [K('full 일', '필요', 'hit'), K('incr 월', '필요', 'hit'), K('incr 화', '필요', 'hit'), K('incr 수', '필요', 'hit')],
      },
      callouts: [
        { node: 'diff', text: '2개로 복원', tone: 'ok' },
        { node: 'incr', text: '4개 모두 필요', tone: 'warn', below: true },
      ],
      nodeNotes: {
        restore: 'pgBackRest는 백업 라벨만 지정하면 필요한 체인을 알아서 모읍니다. PG17 내장은 pg_combinebackup에 순서대로 직접 넘겨야 합니다.',
      },
      flows: [{ edge: 'diff-restore', rate: 1 }, { edge: 'incr-restore', rate: 1.6 }],
    },
    {
      title: '중간 백업 하나가 깨지면',
      note: 'incr 화가 손상되었습니다.\n증분 체인은 끊긴 고리 다음부터 쓸 수 없습니다. incr 수로는 복원할 수 없고, incr 월까지 복원한 뒤 WAL 아카이브로 수요일까지 재생해야 합니다(WAL이 온전할 때만).\n차등은 diff 화가 깨져도 diff 수에 영향이 없습니다. 각 diff가 full에만 기대기 때문입니다.\n어느 쪽이든 full이 깨지면 전부 쓸 수 없습니다.',
      states: { restore: 'normal' },
      slots: {
        diff: [K('full 일', '필요', 'hit'), K('diff 월', '불필요'), K('diff 화', '손상', 'victim'), K('diff 수', '영향 없음', 'hit')],
        incr: [K('full 일', '필요', 'hit'), K('incr 월', '여기까지만', 'hit'), K('incr 화', '손상', 'victim'), K('incr 수', '사용 불가', 'skip')],
      },
      callouts: [
        { node: 'diff', text: '수요일 복원 가능', tone: 'ok' },
        { node: 'incr', text: '체인 끊김 → WAL로 메우기', tone: 'warn', below: true },
      ],
      nodeNotes: {
        incr: '손상 탐지는 pgbackrest verify, 또는 복원 리허설로 합니다.',
        diff: '깨진 diff 화는 다른 백업에 영향이 없습니다.',
      },
      flows: [{ edge: 'diff-restore', rate: 1 }, { edge: 'incr-restore', rate: 1, fail: true }],
    },
    {
      title: '정리: 어떻게 섞어 쓰나',
      note: '차등: 백업이 날마다 커지지만 복원이 단순하고 중간 손상에 강합니다.\n증분: 백업이 가장 작고 빠르지만 복원에 체인 전체가 필요합니다.\n흔한 조합: 주 1회 full + 매일 diff, 백업 창이 짧거나 DB가 크면 사이에 incr를 추가합니다.\n어떤 조합이든 WAL 아카이브가 빈틈을 메우고, 실제 복원 리허설로 검증해야 합니다.',
      edges: { 'diff-restore': 'off', 'incr-restore': 'off' },
      slots: {
        diff: [K('full 일', '주 1회'), K('diff 월', '매일'), K('diff 화', '매일'), K('diff 수', '매일')],
        incr: [K('full 일', '주 1회'), K('incr 월', '자주·작게'), K('incr 화', '자주·작게'), K('incr 수', '자주·작게')],
      },
      flows: [{ edge: 'db-diff', rate: 0.6 }, { edge: 'db-incr', rate: 0.6 }],
    },
  ],
});
