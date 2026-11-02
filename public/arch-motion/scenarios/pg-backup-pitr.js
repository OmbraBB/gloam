// PostgreSQL 백업과 PITR — pgBackRest 방식의 full/diff 백업 + 연속 WAL 아카이빙 + 시점 복구
// 근거: PostgreSQL 공식 문서(Continuous Archiving and PITR, pg_stat_archiver)와 pgBackRest 사용자 가이드
// 저장소 위치·버킷·계정은 넣지 않는다.
const B = (p, sub, hl) => ({ p, sub, hl });

ArchMotion.scenario({
  title: 'PostgreSQL 백업과 PITR',
  summary: '데이터 파일 백업과 WAL 아카이브가 어떻게 짝을 이뤄 "원하는 시각으로 되돌리기"를 가능하게 하는지, 그리고 아카이브가 실패하면 무슨 일이 생기는지 보여줍니다.',
  disclaimer: 'pgBackRest 방식 일반 패턴 · 실제 운영 백업 주기·보존 정책과 다를 수 있음',
  width: 1200,
  height: 700,

  kindNames: { rw: '데이터 변경', ro: '백업·복원 데이터', repl: 'WAL', ctrl: '제어' },

  groups: [
    { label: '운영 DB 서버', x: 250, y: 50, w: 300, h: 520, tone: 'db' },
    { label: '백업 저장소 (repo)', x: 690, y: 160, w: 480, h: 380, tone: 'store' },
    { label: '복구 서버', x: 250, y: 595, w: 300, h: 95, tone: 'db' },
  ],

  nodes: [
    {
      id: 'app', label: '애플리케이션', sub: '쓰기 트래픽', x: 115, y: 130, kind: 'app',
      role: '평소처럼 데이터를 바꿉니다. 모든 변경은 WAL로 남습니다.',
    },
    {
      id: 'pg', label: 'PostgreSQL', sub: '운영 DB', x: 400, y: 130, kind: 'db',
      role: '운영 중인 DB입니다. 백업 중에도 멈추지 않습니다(온라인 백업).',
      details: [
        ['아카이브 설정', 'archive_mode = on, archive_command'],
        ['강제 전환', 'archive_timeout (조용한 DB도 주기적으로 세그먼트 마감)'],
      ],
      notes: ['백업은 데이터 파일 복사본과 그 기간의 WAL이 함께 있어야 쓸 수 있습니다. 데이터 파일만으로는 일관된 상태가 아닙니다.'],
    },
    {
      id: 'pgwal', label: 'pg_wal', sub: 'WAL 세그먼트 16MB', x: 400, y: 330, kind: 'disk',
      role: '변경 기록이 16MB 세그먼트 파일로 쌓이는 디렉터리입니다. 세그먼트가 다 차거나 강제 전환되면 아카이브 대상이 됩니다.',
      details: [
        ['아카이브 대기 표시', 'archive_status/*.ready'],
        ['정리 조건', '아카이브 완료 + 체크포인트 이후 불필요'],
      ],
      notes: ['아카이브가 실패하면 여기서 지울 수 없어 계속 쌓입니다. 디스크가 차면 DB가 멈춥니다.'],
    },
    {
      id: 'arch', label: 'archiver', sub: 'archive-push', x: 400, y: 495, kind: 'proc',
      role: '마감된 WAL 세그먼트를 하나씩 백업 저장소로 보냅니다. archive_command로 pgBackRest의 archive-push를 부릅니다.',
      details: [
        ['명령 예', 'archive_command = pgbackrest --stanza=<이름> archive-push %p'],
        ['상태', 'pg_stat_archiver: archived_count, failed_count, last_failed_wal'],
      ],
      notes: ['failed_count가 오르거나 last_archived_time이 멈추면 바로 알림이 가야 합니다.'],
    },
    {
      id: 'job', label: 'pgbackrest backup', sub: '정기 실행 (cron)', x: 860, y: 70, w: 200, kind: 'proc',
      role: '정해진 주기로 데이터 파일 백업을 만듭니다. 종류에 따라 전체 또는 바뀐 파일만 복사합니다.',
      details: [
        ['full', '전체 데이터 파일'],
        ['diff', '마지막 full 이후 바뀐 파일'],
        ['incr', '마지막 백업(종류 무관) 이후 바뀐 파일'],
        ['보존', 'repo1-retention-full / -diff, 만료는 expire'],
      ],
      notes: ['PG17부터는 pg_basebackup --incremental과 pg_combinebackup으로도 증분 백업을 할 수 있습니다(summarize_wal 필요).'],
    },
    {
      id: 'repobk', label: '백업 세트', sub: 'backup/', x: 930, y: 270, w: 400, h: 130, kind: 'store',
      slots: { cols: 3, w: 110, h: 50, empty: '—' },
      role: '데이터 파일 백업 묶음입니다. diff는 기준이 되는 full이 있어야 복원할 수 있습니다.',
      details: [
        ['목록 확인', 'pgbackrest info'],
        ['무결성', '파일 체크섬 저장, 복원 시 검증'],
      ],
      notes: ['full을 지우면 그 full에 기대는 diff·incr도 쓸 수 없습니다. 보존 정책은 세트 단위로 생각합니다.'],
    },
    {
      id: 'repowal', label: 'WAL 아카이브', sub: 'archive/', x: 930, y: 440, w: 400, h: 130, kind: 'store',
      slots: { cols: 5, w: 64, h: 50, empty: '—' },
      role: '마감된 WAL 세그먼트가 순서대로 모이는 곳입니다. 백업 시점 이후 원하는 시각까지 이 WAL을 재생해 되돌립니다.',
      details: [
        ['연속성', '중간에 세그먼트 하나라도 빠지면 그 이후로는 복구 불가'],
        ['점검', 'pgbackrest check (아카이브 왕복 확인)'],
      ],
    },
    {
      id: 'restore', label: '복구 서버', sub: 'PITR 대상', x: 400, y: 645, w: 220, kind: 'db',
      role: '백업 세트를 풀고 WAL을 원하는 시각까지 재생해 만든 별도 서버입니다. 운영 DB를 덮어쓰지 않고 여기서 필요한 데이터만 되살리는 편이 안전합니다.',
      details: [
        ['복원', 'pgbackrest restore --type=time --target="<시각>"'],
        ['WAL 가져오기', 'restore_command → archive-get'],
        ['도착 후', 'recovery_target_action (기본 pause) → 확인 후 promote'],
      ],
      notes: ['백업은 복구해 봐야 검증됩니다. 정기적으로 복구 리허설을 하고 걸린 시간(RTO)을 기록합니다.'],
    },
  ],

  edges: [
    { id: 'app-pg', from: 'app', to: 'pg', kind: 'rw' },
    { id: 'pg-wal', from: 'pg', to: 'pgwal', kind: 'repl' },
    { id: 'wal-arch', from: 'pgwal', to: 'arch', kind: 'repl' },
    { id: 'arch-repo', from: 'arch', to: 'repowal', kind: 'repl', label: 'archive-push' },
    { id: 'job-pg', from: 'job', to: 'pg', kind: 'ctrl', label: 'backup start/stop' },
    { id: 'pg-repobk', from: 'pg', to: 'repobk', kind: 'ro', label: '파일 복사' },
    { id: 'repobk-restore', from: 'repobk', to: 'restore', kind: 'ro', fromSide: 'left', toSide: 'right', bend: 60, label: 'restore', hidden: true },
    { id: 'repowal-restore', from: 'repowal', to: 'restore', kind: 'repl', fromSide: 'bottom', toSide: 'right', bend: -40, label: 'archive-get', hidden: true },
  ],

  steps: [
    {
      title: '연속 WAL 아카이빙',
      note: '모든 변경은 WAL에 남고, 16MB 세그먼트가 마감될 때마다 archiver가 저장소로 보냅니다.\n이 흐름은 백업 작업과 관계없이 항상 돌고 있어야 합니다.\n트래픽이 적은 DB는 세그먼트가 늦게 차므로 archive_timeout으로 주기적으로 마감합니다.',
      slots: {
        repobk: [{}, {}, {}],
        repowal: [B('seg 101', '13:50'), B('seg 102', '13:55'), B('seg 103', '14:00', 'load'), {}, {}],
      },
      nodeNotes: {
        arch: 'seg 103을 저장소로 보냈습니다.',
        pgwal: '아카이브가 끝난 세그먼트는 체크포인트 이후 재활용됩니다.',
      },
      flows: [
        { edge: 'app-pg', rate: 1.4 },
        { edge: 'pg-wal', rate: 1.4 },
        { edge: 'wal-arch', rate: 0.8 },
        { edge: 'arch-repo', rate: 0.8 },
      ],
    },
    {
      title: '전체 백업 (full)',
      note: 'pgBackRest가 백업 시작을 알리고 데이터 파일 전체를 복사합니다. DB는 계속 운영 중입니다.\n복사하는 동안에도 파일이 바뀌므로 복사본만으로는 일관되지 않습니다.\n백업 시작~종료 사이의 WAL을 함께 재생해야 일관된 상태가 됩니다. 그래서 백업과 아카이브는 한 세트입니다.',
      slots: { repobk: [B('full 10/26', '전체 · 기준점', 'load'), {}, {}] },
      callouts: [{ node: 'repobk', text: '백업 중 WAL도 필요', tone: 'info' }],
      nodeNotes: {
        job: 'full 백업을 실행합니다.',
        pg: '백업 중에도 쓰기를 받습니다. 백업 시작·종료 지점이 WAL에 기록됩니다.',
        repobk: 'full 10/26이 이후 diff의 기준점이 됩니다.',
      },
      flows: [
        { edge: 'job-pg', rate: 0.6, size: 4 },
        { edge: 'pg-repobk', rate: 1.6 },
        { edge: 'app-pg', rate: 1 },
        { edge: 'pg-wal', rate: 1 },
        { edge: 'wal-arch', rate: 0.6 },
        { edge: 'arch-repo', rate: 0.6 },
      ],
    },
    {
      title: '차등 백업 (diff)',
      note: '이후에는 마지막 full 이후 바뀐 파일만 복사하는 diff를 쌓습니다.\n복원할 때는 full + 가장 최근 diff 두 개면 됩니다(incr는 사이 백업이 모두 필요).\n보존 정책에 따라 오래된 백업과, 남은 백업 복구에 필요 없는 WAL은 expire로 정리됩니다.',
      slots: {
        repobk: [B('full 10/26', '전체'), B('diff 10/28', 'full 이후 변경'), B('diff 10/30', 'full 이후 변경', 'load')],
        repowal: [B('seg 101', '13:50'), B('seg 102', '13:55'), B('seg 103', '14:00'), B('seg 104', '14:05'), {}],
      },
      nodeNotes: {
        job: 'diff를 실행합니다. 바뀐 파일만 복사하므로 full보다 빠릅니다.',
        repobk: 'full 하나에 diff 둘이 붙어 있습니다.',
      },
      flows: [
        { edge: 'job-pg', rate: 0.6, size: 4 },
        { edge: 'pg-repobk', rate: 0.9 },
        { edge: 'wal-arch', rate: 0.6 },
        { edge: 'arch-repo', rate: 0.6 },
      ],
    },
    {
      title: '사고: 14:05 실수 DELETE',
      note: '누군가 WHERE 없이 DELETE를 실행했습니다.\nStandby(복제)는 이 DELETE도 곧바로 따라 하므로 되돌리는 데 쓸 수 없습니다. 복제는 백업이 아닙니다.\n되돌리려면 14:05 직전 상태를 백업 + WAL로 다시 만들어야 합니다.',
      states: { pg: 'down' },
      labels: { pg: 'PostgreSQL' },
      subs: { pg: '데이터 손상' },
      callouts: [{ node: 'pg', text: '14:05 DELETE 실수', tone: 'warn', below: true }],
      nodeNotes: {
        pg: '삭제가 커밋되어 WAL에도 기록되었습니다.',
        repowal: '실수가 담긴 WAL(seg 104 이후)도 그대로 아카이브됩니다. 재생할 때 그 직전에서 멈추면 됩니다.',
      },
      flows: [
        { edge: 'app-pg', rate: 1.6, kind: 'fail' },
        { edge: 'pg-wal', rate: 1.2 },
      ],
    },
    {
      title: '시점 복구 (PITR)',
      note: '별도 복구 서버에 목표 시각 이전의 가장 가까운 백업(full + diff 10/30)을 풉니다.\n그다음 WAL 아카이브를 차례로 가져와 재생하다가 14:04:59에 멈춥니다.\n기본 동작은 pause라서, 데이터를 확인한 뒤 promote하거나 필요한 행만 운영 DB로 옮깁니다.',
      edges: { 'repobk-restore': 'on', 'repowal-restore': 'on' },
      states: { restore: 'recovering' },
      subs: { restore: '14:04:59까지 재생' },
      slots: {
        repobk: [B('full 10/26', '복원 기준', 'hit'), B('diff 10/28', '건너뜀'), B('diff 10/30', '복원', 'hit')],
        repowal: [B('seg 101', '13:50', 'hit'), B('seg 102', '13:55', 'hit'), B('seg 103', '14:00', 'hit'), B('seg 104', '~14:04:59', 'hit'), {}],
      },
      callouts: [{ node: 'restore', text: 'target 도달 → pause', tone: 'ok' }],
      nodeNotes: {
        restore: '백업을 풀고 restore_command로 WAL을 받아 목표 시각까지 재생합니다.',
        repobk: 'full + 가장 최근 diff만 씁니다. diff 10/28은 필요 없습니다.',
        repowal: 'diff 10/30 이후의 세그먼트를 순서대로 재생합니다. 하나라도 빠지면 거기서 멈춥니다.',
      },
      flows: [
        { edge: 'repobk-restore', rate: 1.4 },
        { edge: 'repowal-restore', rate: 1.2 },
      ],
    },
    {
      title: '아카이브가 실패하면',
      note: '저장소 권한·네트워크 문제로 archive-push가 계속 실패하는 상황입니다.\n아카이브되지 않은 세그먼트는 지울 수 없으므로 pg_wal이 계속 커집니다.\n디스크가 차면 운영 DB가 멈춥니다. 그 사이 PITR 가능 범위도 끊깁니다.\npg_stat_archiver.failed_count, last_archived_time과 pg_wal 크기를 감시해야 합니다.',
      edges: { 'repobk-restore': 'off', 'repowal-restore': 'off' },
      states: { pg: 'normal', restore: 'normal', pgwal: 'busy' },
      subs: { pg: '운영 DB', restore: 'PITR 대상' },
      slots: {
        repobk: [B('full 10/26', '전체'), B('diff 10/28', 'full 이후 변경'), B('diff 10/30', 'full 이후 변경')],
        repowal: [B('seg 101', '13:50'), B('seg 102', '13:55'), B('seg 103', '14:00'), B('seg 104', '14:05'), B('seg 105', '전송 실패', 'victim')],
      },
      callouts: [
        { node: 'pgwal', text: 'pg_wal 계속 증가', tone: 'warn' },
        { node: 'arch', text: 'failed_count ↑', tone: 'warn', below: true },
      ],
      nodeNotes: {
        arch: '같은 세그먼트를 계속 재시도하며 실패합니다.',
        pgwal: '.ready 파일이 쌓이고 디스크 사용량이 계속 오릅니다.',
        repowal: 'seg 105부터 끊겼습니다. 이 시점 이후로는 PITR이 불가능합니다.',
      },
      flows: [
        { edge: 'app-pg', rate: 1.4 },
        { edge: 'pg-wal', rate: 1.6 },
        { edge: 'wal-arch', rate: 0.8 },
        { edge: 'arch-repo', rate: 0.8, fail: true },
      ],
    },
  ],
});
