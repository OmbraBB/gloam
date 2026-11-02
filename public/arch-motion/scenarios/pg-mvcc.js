// PostgreSQL MVCC — 튜플 버전(xmin/xmax), 스냅샷, HOT, VACUUM과 xmin horizon
// 근거: PostgreSQL 공식 문서(Concurrency Control, Routine Vacuuming, Storage Page Layout)와 src/backend/access/heap/README.HOT
// 슬롯 = 힙 페이지 0번의 line pointer. 표기 (블록, 번호).
const T = (p, sub, extra) => Object.assign({ p, sub }, extra);
const EMPTY = {};

ArchMotion.scenario({
  title: 'PostgreSQL MVCC와 VACUUM',
  summary: 'UPDATE가 행을 덮어쓰지 않고 새 버전을 만드는 과정, 트랜잭션마다 다른 버전이 보이는 이유, 오래 열린 트랜잭션이 VACUUM을 막는 원리를 튜플 단위로 보여줍니다.',
  disclaimer: '커뮤니티 PostgreSQL 기준 · xid·페이지는 설명용 단순화',
  width: 1160,
  height: 620,

  kindNames: { rw: '쓰기(새 버전)', ro: '읽기(보이는 버전)', ctrl: '상태 확인·정리' },

  groups: [
    { label: '트랜잭션', x: 20, y: 60, w: 200, h: 540, tone: 'proc' },
    { label: '테이블 users', x: 270, y: 30, w: 420, h: 570, tone: 'mem' },
    { label: '관리', x: 720, y: 60, w: 210, h: 540, tone: 'ctrl' },
  ],

  nodes: [
    {
      id: 'txA', label: '트랜잭션 A', sub: 'xid 101 · UPDATE', x: 120, y: 160, kind: 'proc',
      role: 'id=1 행의 잔액을 100에서 70으로 바꾸는 트랜잭션입니다. 쓰기를 시작하면 트랜잭션 ID(xid) 101을 받습니다.',
      details: [
        ['xid 발급', '첫 쓰기 시점 (읽기 전용이면 발급 안 됨)'],
        ['확인', 'SELECT txid_current() / pg_current_xact_id()'],
      ],
      notes: ['UPDATE는 원래 행을 고치지 않습니다. 새 버전을 만들고 옛 버전에 "101이 지웠음"(xmax)을 표시합니다.'],
    },
    {
      id: 'txB', label: '트랜잭션 B', sub: 'REPEATABLE READ', x: 120, y: 340, kind: 'proc',
      role: 'A보다 먼저 시작한 조회 트랜잭션입니다. 시작할 때 찍은 스냅샷을 끝날 때까지 씁니다.',
      details: [
        ['스냅샷', 'xid 101 이상은 "아직 안 일어난 일"로 취급'],
        ['격리 수준', 'REPEATABLE READ (트랜잭션 전체에 스냅샷 1개)'],
      ],
      notes: [
        'READ COMMITTED(기본)라면 문장마다 새 스냅샷을 찍으므로, A가 커밋한 뒤의 다음 SELECT부터 70이 보입니다.',
      ],
    },
    {
      id: 'txC', label: '오래 열린 트랜잭션', sub: 'idle in transaction', x: 120, y: 520, kind: 'proc',
      role: '한참 전에 BEGIN만 하고 끝내지 않은 세션입니다. 아무 일도 안 하지만 스냅샷을 쥐고 있어서 VACUUM이 지울 수 있는 범위(xmin horizon)를 붙잡습니다.',
      details: [
        ['찾기', "pg_stat_activity: state = 'idle in transaction', backend_xmin"],
        ['방어 설정', 'idle_in_transaction_session_timeout'],
      ],
      notes: [
        '같은 효과를 내는 것: 복제 슬롯의 xmin, hot_standby_feedback이 켜진 Standby의 긴 쿼리, 방치된 prepared transaction.',
      ],
    },
    {
      id: 'idx', label: 'users_pkey', sub: '인덱스 · id → ctid', x: 480, y: 100, w: 200, kind: 'store',
      role: '기본키 인덱스입니다. 키(id)마다 힙의 위치(ctid)를 가리킵니다. 인덱스 자체에는 가시성 정보가 없어서, 찾은 뒤 힙에서 버전을 확인합니다.',
      details: [
        ['항목', 'id=1 → (0,1), id=2 → (0,2)'],
        ['가시성', '힙 튜플의 xmin/xmax로 판단 (Index Only Scan은 visibility map 활용)'],
      ],
    },
    {
      id: 'heap', label: '힙 페이지 0', sub: 'line pointer별 튜플', x: 480, y: 330, w: 400, h: 200, kind: 'mem',
      slots: { cols: 2, w: 176, h: 52, empty: '빈 공간' },
      role: '테이블 데이터가 들어 있는 8KB 페이지입니다. 같은 행의 여러 버전이 함께 들어 있을 수 있고, 각 튜플 헤더에 xmin(만든 xid)과 xmax(지운 xid)가 적혀 있습니다.',
      details: [
        ['튜플 헤더', 'xmin, xmax, ctid(다음 버전 위치), hint bits'],
        ['직접 보기', 'pageinspect 확장의 heap_page_items()'],
        ['숨은 컬럼', 'SELECT xmin, xmax, ctid, * FROM users'],
      ],
      notes: [
        'dead 튜플이 쌓이면 같은 데이터에 더 많은 페이지를 읽게 됩니다(bloat).',
        'fillfactor를 낮춰 페이지에 여유를 두면 HOT 업데이트가 잘 일어납니다.',
      ],
    },
    {
      id: 'xact', label: 'pg_xact', sub: '트랜잭션 커밋 상태', x: 825, y: 160, w: 180, kind: 'ctrl',
      role: 'xid마다 진행 중·커밋·중단 상태를 기록하는 곳입니다. 튜플의 xmin/xmax가 커밋됐는지 여기서 확인합니다.',
      details: [
        ['예전 이름', 'pg_clog'],
        ['속도 보완', '확인 결과를 튜플의 hint bits에 캐시'],
      ],
      notes: ['커밋 직후 처음 읽는 SELECT가 hint bits를 쓰면서 페이지를 dirty로 만들 수 있습니다. 읽기인데 쓰기 I/O가 생기는 이유입니다.'],
    },
    {
      id: 'vac', label: 'autovacuum', sub: 'VACUUM', x: 825, y: 470, w: 180, kind: 'proc',
      role: '아무도 볼 수 없는 dead 튜플을 지워 공간을 재사용하게 만듭니다. "아무도 볼 수 없다"의 기준이 가장 오래된 스냅샷(xmin horizon)입니다.',
      details: [
        ['제거 조건', 'xmax 커밋 완료 · xmax가 xmin horizon보다 오래됨'],
        ['트리거', 'autovacuum_vacuum_scale_factor (기본 0.2) + threshold (50)'],
        ['통계', 'pg_stat_user_tables.n_dead_tup, last_autovacuum'],
      ],
      notes: [
        '지운 공간은 테이블 안에서 재사용될 뿐 파일 크기는 줄지 않습니다. 줄이려면 VACUUM FULL이나 pg_repack이 필요합니다.',
        '오래된 xmin을 FROZEN으로 바꾸는 것도 VACUUM의 일입니다. 못 하면 xid wraparound 방어로 강제 VACUUM이 돕니다.',
      ],
    },
  ],

  edges: [
    { id: 'A-heap', from: 'txA', to: 'heap', kind: 'rw', bend: 14 },
    { id: 'heap-A', from: 'heap', to: 'txA', kind: 'ro', bend: 14 },
    { id: 'heap-B', from: 'heap', to: 'txB', kind: 'ro' },
    { id: 'idx-heap', from: 'idx', to: 'heap', kind: 'ctrl', label: 'ctid' },
    { id: 'A-xact', from: 'txA', to: 'xact', kind: 'ctrl', label: 'COMMIT', bend: -30 },
    { id: 'heap-xact', from: 'heap', to: 'xact', kind: 'ctrl', label: '커밋됐나?' },
    { id: 'C-vac', from: 'txC', to: 'vac', kind: 'ctrl', label: 'xmin horizon', hidden: true, bend: 30 },
    { id: 'vac-heap', from: 'vac', to: 'heap', kind: 'ctrl' },
  ],

  steps: [
    {
      title: '처음 상태',
      note: 'id=1 행(잔액 100)은 xid 90이 만들었고 아무도 지우지 않았습니다(xmax 없음).\n트랜잭션 B가 REPEATABLE READ로 시작해 스냅샷을 찍었습니다. B에게는 xid 101 이상이 "아직 일어나지 않은 일"입니다.\n오래 열린 트랜잭션 C는 그보다 더 먼저 시작해 아직 열려 있습니다.',
      slots: {
        heap: [
          T('(0,1) id=1 잔액 100', 'xmin 90 · xmax —'),
          T('(0,2) id=2 잔액 50', 'xmin 92 · xmax —'),
          EMPTY, EMPTY,
        ],
      },
      nodeNotes: {
        txB: '스냅샷을 찍었습니다. 이후 커밋되는 xid 101 이상의 변경은 B에게 보이지 않습니다.',
        heap: '각 행이 버전 하나씩만 있습니다.',
      },
      flows: [{ edge: 'heap-B', rate: 1 }, { edge: 'idx-heap', rate: 0.5, size: 3.5 }],
    },
    {
      title: 'UPDATE = 새 버전 + 옛 버전 표시',
      note: 'A(xid 101)가 id=1의 잔액을 70으로 바꿉니다.\n원래 튜플 (0,1)은 그대로 두고 xmax=101만 적습니다. 새 튜플 (0,3)을 xmin=101로 만듭니다.\nA는 자기가 만든 (0,3)을 보고, B는 아직 101이 커밋되지 않았으므로 (0,1)을 봅니다.\n읽는 쪽과 쓰는 쪽이 서로 막지 않는 이유가 이것입니다.',
      slots: {
        heap: [
          T('(0,1) id=1 잔액 100', 'xmin 90 · xmax 101', { hl: 'write' }),
          T('(0,2) id=2 잔액 50', 'xmin 92 · xmax —'),
          T('(0,3) id=1 잔액 70', 'xmin 101 · xmax —', { hl: 'load' }),
          EMPTY,
        ],
      },
      callouts: [{ node: 'heap', text: '같은 행, 버전 2개', tone: 'info' }],
      nodeNotes: {
        txA: '(0,3)을 만들고 (0,1)의 xmax에 101을 적었습니다. 아직 커밋 전입니다.',
        txB: '(0,1)을 봅니다. xmax 101은 아직 커밋되지 않았으니 "아직 안 지워진 행"입니다.',
        heap: '(0,1)과 (0,3)이 같은 행 id=1의 두 버전입니다. (0,1)의 ctid가 (0,3)을 가리킵니다.',
      },
      flows: [
        { edge: 'A-heap', rate: 1.2 },
        { edge: 'heap-A', rate: 1 },
        { edge: 'heap-B', rate: 1 },
      ],
    },
    {
      title: 'COMMIT과 가시성',
      note: 'A가 커밋하면 pg_xact에 "101 커밋"이 기록됩니다. 튜플은 하나도 바뀌지 않습니다.\n이후 새로 시작한 트랜잭션은 (0,3) 잔액 70을 봅니다.\n하지만 B는 스냅샷이 101 이전이라 여전히 (0,1) 잔액 100을 봅니다.\n가시성은 "튜플의 xmin/xmax + pg_xact + 내 스냅샷" 세 가지로 결정됩니다.',
      slots: {
        heap: [
          T('(0,1) id=1 잔액 100', 'xmin 90 · xmax 101'),
          T('(0,2) id=2 잔액 50', 'xmin 92 · xmax —'),
          T('(0,3) id=1 잔액 70', 'xmin 101 · xmax —', { hl: 'hit' }),
          EMPTY,
        ],
      },
      callouts: [{ node: 'xact', text: '101 = 커밋', tone: 'ok', below: true }],
      nodeNotes: {
        xact: 'xid 101의 상태가 커밋으로 바뀌었습니다. 커밋은 이 한 줄과 WAL 기록이 전부입니다.',
        txB: '여전히 잔액 100을 봅니다. 스냅샷 기준으로 101은 미래이기 때문입니다.',
        heap: '새 트랜잭션은 (0,3)을, B는 (0,1)을 봅니다.',
      },
      flows: [
        { edge: 'A-xact', rate: 1 },
        { edge: 'heap-xact', rate: 0.8, size: 4 },
        { edge: 'heap-B', rate: 1 },
      ],
    },
    {
      title: '인덱스는? (HOT)',
      note: '인덱스는 여전히 id=1 → (0,1)을 가리킵니다. 그런데도 새 인덱스 항목을 만들지 않았습니다.\n바뀐 컬럼(잔액)이 어떤 인덱스에도 없고 새 버전이 같은 페이지에 들어갔기 때문입니다(HOT 업데이트).\n인덱스로 찾아온 조회는 (0,1)에서 ctid 체인을 따라 (0,3)으로 갑니다.\n인덱스 컬럼이 바뀌거나 페이지에 자리가 없으면 HOT이 안 되고 모든 인덱스에 새 항목이 생깁니다.',
      callouts: [{ node: 'idx', text: '인덱스 수정 없음', tone: 'ok', below: true }],
      nodeNotes: {
        idx: 'id=1 → (0,1) 그대로입니다. HOT 덕분에 인덱스 쓰기를 아꼈습니다.',
        heap: '(0,1) → (0,3) HOT 체인입니다. 체인은 한 페이지 안에서만 이어질 수 있습니다.',
        txA: 'pg_stat_user_tables.n_tup_hot_upd로 HOT 비율을 볼 수 있습니다.',
      },
      flows: [{ edge: 'idx-heap', rate: 1, size: 4 }],
    },
    {
      title: 'VACUUM이 못 지우는 경우',
      note: 'B는 끝났지만, C가 101보다 먼저 찍은 스냅샷을 아직 쥐고 있습니다.\nC 입장에서는 (0,1) 잔액 100이 아직 보여야 하는 버전입니다.\n그래서 autovacuum이 돌아도 (0,1)을 "dead지만 아직 못 지움"으로 남겨 둡니다.\n이런 세션 하나가 DB 전체 테이블의 정리를 막아 bloat가 커집니다.',
      edges: { 'C-vac': 'on' },
      slots: {
        heap: [
          T('(0,1) id=1 잔액 100', 'dead · 아직 제거 불가', { hl: 'skip' }),
          T('(0,2) id=2 잔액 50', 'xmin 92 · xmax —'),
          T('(0,3) id=1 잔액 70', 'xmin 101 · xmax —'),
          EMPTY,
        ],
      },
      states: { txC: 'busy' },
      callouts: [{ node: 'vac', text: 'dead but not yet removable', tone: 'warn', below: true }],
      nodeNotes: {
        txC: 'backend_xmin이 101보다 작아서 xmin horizon을 붙잡고 있습니다.',
        vac: 'VACUUM VERBOSE 로그에 "dead but not yet removable"과 oldest xmin이 찍힙니다.',
        heap: '(0,1)은 쓸모없지만 C 때문에 남아 있습니다.',
      },
      flows: [
        { edge: 'C-vac', rate: 0.8, size: 4 },
        { edge: 'vac-heap', rate: 0.8, size: 4, fail: true },
      ],
    },
    {
      title: '정리 후',
      note: 'C가 끝나자 xmin horizon이 앞으로 당겨졌습니다.\n이제 (0,1)의 옛 데이터는 아무도 볼 수 없으므로 정리됩니다. 공간은 페이지 안에서 다시 쓸 수 있습니다.\nHOT 체인의 시작점인 (0,1) line pointer는 지워지지 않고 (0,3)으로 가는 redirect로 남습니다. 인덱스가 아직 (0,1)을 가리키기 때문입니다.\n파일 크기는 그대로이고, 빈 공간은 FSM에, 페이지 전체가 보이는 상태는 visibility map에 기록됩니다.',
      edges: { 'C-vac': 'off' },
      states: { txC: 'normal' },
      labels: { txC: '오래 열린 트랜잭션' },
      subs: { txC: '종료됨' },
      slots: {
        heap: [
          T('(0,1) redirect', '→ (0,3)', { hl: 'dead' }),
          T('(0,2) id=2 잔액 50', 'xmin 92 · xmax —'),
          T('(0,3) id=1 잔액 70', 'xmin 101 · xmax —'),
          T(null, null),
        ],
      },
      callouts: [{ node: 'heap', text: '공간 재사용 가능', tone: 'ok' }],
      nodeNotes: {
        vac: 'dead 튜플 데이터를 정리하고 FSM·visibility map을 갱신했습니다.',
        heap: '(0,1)은 redirect만 남았고, 데이터 자리는 다음 INSERT·UPDATE가 씁니다.',
        idx: '여전히 (0,1)을 가리키고, redirect를 거쳐 (0,3)에 닿습니다.',
      },
      flows: [{ edge: 'vac-heap', rate: 1, size: 4 }],
    },
  ],
});
