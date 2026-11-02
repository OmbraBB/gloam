// PostgreSQL shared_buffers 내부 동작 — 커뮤니티 PostgreSQL 기준
// 근거: PostgreSQL 공식 문서(Resource Consumption, WAL Configuration, pg_stat_io/pg_stat_checkpointer)와
//      소스 src/backend/storage/buffer/README(클럭 스윕·usage_count·bgwriter 규칙)
// 슬롯 표기: 테이블:블록번호, 점=usage_count(0~5), D=dirty, PIN=사용 중(교체 불가)
const S = (p, uc, extra) => Object.assign({ p, uc }, extra);

ArchMotion.scenario({
  title: 'PostgreSQL shared_buffers 내부 동작',
  summary: '페이지를 읽고 바꾸고 디스크에 쓰기까지 — 버퍼 히트·미스, 클럭 스윕 교체, WAL 우선 기록, bgwriter와 checkpointer의 역할을 슬롯 단위로 보여줍니다.',
  disclaimer: '커뮤니티 PostgreSQL 기준 · Aurora는 스토리지 계층이 페이지를 만들어 체크포인트·dirty 페이지 쓰기·FPW 단계가 다름 · 슬롯 8칸은 설명용 축소',
  width: 1200,
  height: 660,

  kindNames: { ro: '페이지 읽기', rw: '페이지 변경·쓰기', repl: 'WAL 기록', ctrl: '조회·제어' },

  groups: [
    { label: '백엔드', x: 20, y: 60, w: 190, h: 570, tone: 'proc' },
    { label: '공유 메모리', x: 250, y: 60, w: 460, h: 570, tone: 'mem' },
    { label: '백그라운드 프로세스', x: 770, y: 70, w: 410, h: 140, tone: 'proc' },
    { label: '커널', x: 760, y: 250, w: 190, h: 180, tone: 'disk' },
    { label: '디스크', x: 990, y: 250, w: 190, h: 380, tone: 'disk' },
  ],

  nodes: [
    {
      id: 'be', label: '백엔드 프로세스', sub: 'client backend', x: 115, y: 340, kind: 'proc',
      role: '클라이언트 커넥션 하나마다 생기는 프로세스입니다. 쿼리를 실행하면서 필요한 페이지를 shared_buffers에서 찾고, 페이지를 바꿀 때는 먼저 WAL 레코드를 남깁니다.',
      details: [
        ['단위', '커넥션 1개 = 프로세스 1개'],
        ['상태 확인', 'pg_stat_activity'],
        ['I/O 통계', 'pg_stat_io (backend_type별, PG16+)'],
      ],
      notes: [
        '교체할 버퍼가 dirty면 백엔드가 직접 디스크에 써야 해서 쿼리가 느려집니다. bgwriter가 이 일을 미리 줄여 줍니다.',
        'pg_stat_io에서 client backend의 writes가 많다면 bgwriter·checkpointer가 따라가지 못한다는 신호입니다.',
      ],
    },
    {
      id: 'hash', label: '버퍼 매핑 해시', sub: 'buffer tag → buffer id', x: 480, y: 140, w: 200, kind: 'mem',
      role: '"이 페이지가 지금 shared_buffers 어느 칸에 있나"를 찾는 해시 테이블입니다. 키는 buffer tag(파일·fork·블록 번호)입니다.',
      details: [
        ['키', 'relfilenode + fork + 블록 번호'],
        ['값', 'buffer id (슬롯 번호)'],
        ['락', '128개 파티션 LWLock'],
      ],
      notes: [
        '동시 접근이 많으면 대기 이벤트 LWLock:BufferMapping이 보입니다.',
      ],
    },
    {
      id: 'sb', label: 'shared_buffers', sub: 'dots=usage_count · D=dirty · PIN=pinned', x: 480, y: 340, w: 400, h: 200, kind: 'mem',
      slots: { cols: 4 },
      role: '디스크 페이지(8KB)를 담아 두는 공유 캐시입니다. 모든 백엔드가 같은 슬롯 배열을 함께 씁니다. 칸이 모자라면 클럭 스윕으로 내보낼 칸을 고릅니다.',
      details: [
        ['설정', 'shared_buffers (기본 128MB, 보통 RAM 25%에서 시작)'],
        ['슬롯 정보', 'tag, usage_count(0~5), pin 수, dirty 여부'],
        ['내용 확인', 'pg_buffercache 확장'],
        ['교체 방식', '클럭 스윕 (usage_count 기반 근사 LRU)'],
      ],
      notes: [
        '큰 테이블의 순차 스캔(shared_buffers 1/4 초과)과 VACUUM은 작은 링 버퍼만 돌려 써서 캐시 전체를 밀어내지 않습니다.',
        '재시작하면 비워집니다. 중요한 테이블은 pg_prewarm으로 미리 올릴 수 있습니다.',
      ],
    },
    {
      id: 'walbuf', label: 'WAL 버퍼', sub: 'wal_buffers', x: 480, y: 560, w: 200, kind: 'mem',
      role: '변경 기록(WAL 레코드)을 디스크에 쓰기 전에 모아 두는 메모리입니다.',
      details: [
        ['설정', 'wal_buffers (기본 -1 = shared_buffers의 1/32, 64kB~16MB)'],
        ['비우는 시점', '커밋, 버퍼 가득 참, walwriter 주기'],
      ],
      notes: [
        '쓰기가 몰려 버퍼가 차면 백엔드가 직접 WAL을 쓰며 기다립니다(대기 이벤트 WALWrite).',
      ],
    },
    {
      id: 'bgw', label: 'bgwriter', sub: 'background writer', x: 860, y: 140, kind: 'proc',
      role: '곧 교체될 dirty 버퍼를 미리 커널로 내보내서, 백엔드가 빈 칸을 찾을 때 깨끗한 칸을 바로 쓰게 합니다.',
      details: [
        ['대상', 'usage_count 0 · pin 없음 · dirty 인 버퍼'],
        ['주기', 'bgwriter_delay (기본 200ms)'],
        ['회당 상한', 'bgwriter_lru_maxpages (기본 100)'],
        ['통계', 'pg_stat_bgwriter.buffers_clean'],
      ],
      notes: [
        '최근에 쓰인(usage_count>0) 버퍼는 건너뜁니다. 곧 다시 쓰일 페이지를 쓸데없이 여러 번 쓰지 않기 위해서입니다.',
        'maxwritten_clean이 자주 오르면 회당 상한에 걸려 멈춘 것입니다.',
      ],
    },
    {
      id: 'ckpt', label: 'checkpointer', sub: 'checkpoint', x: 1070, y: 140, kind: 'proc',
      role: '주기적으로 모든 dirty 버퍼를 디스크에 쓰고 fsync해서 "여기까지는 데이터 파일에 반영됨" 지점을 만듭니다. 크래시 복구는 이 지점부터 WAL을 재생합니다.',
      details: [
        ['트리거', 'checkpoint_timeout (기본 5min) 또는 max_wal_size (기본 1GB)'],
        ['분산', 'checkpoint_completion_target (기본 0.9)'],
        ['통계', 'pg_stat_checkpointer (PG17+)'],
      ],
      notes: [
        '체크포인트 직후에는 페이지마다 첫 변경 때 전체 페이지 이미지(FPW)가 WAL에 실려 WAL이 크게 늘어납니다.',
        '요청 체크포인트(max_wal_size 초과)가 잦으면 max_wal_size가 작다는 신호입니다.',
      ],
    },
    {
      id: 'os', label: 'OS 페이지 캐시', sub: 'kernel page cache', x: 850, y: 340, kind: 'mem',
      role: 'PostgreSQL의 read()/write()는 먼저 커널 캐시를 거칩니다. 디스크에 확실히 남기려면 fsync가 필요합니다.',
      details: [
        ['관계', 'shared_buffers와 같은 페이지를 이중으로 보관할 수 있음'],
        ['플래너 힌트', 'effective_cache_size (메모리 할당 아님)'],
      ],
      notes: [
        'shared_buffers를 RAM 대부분으로 잡지 않는 이유가 이 이중 캐시입니다.',
      ],
    },
    {
      id: 'data', label: '데이터 파일', sub: 'base/<db>/<relfilenode>', x: 1085, y: 340, kind: 'disk',
      role: '테이블·인덱스 페이지가 실제로 저장되는 파일입니다.',
      details: [
        ['페이지 크기', '8KB'],
        ['파일 분할', '1GB 세그먼트 단위'],
      ],
    },
    {
      id: 'walfile', label: 'WAL 파일', sub: 'pg_wal/', x: 1085, y: 560, kind: 'disk',
      role: '모든 변경 기록이 순서대로 쌓이는 파일입니다. 커밋은 여기까지 fsync되면 확정됩니다.',
      details: [
        ['세그먼트', '16MB (기본)'],
        ['재활용', '체크포인트 redo 지점 이전 세그먼트'],
      ],
    },
  ],

  edges: [
    { id: 'be-hash', from: 'be', to: 'hash', kind: 'ctrl' },
    { id: 'hash-sb', from: 'hash', to: 'sb', kind: 'ctrl', label: 'buffer id' },
    { id: 'sb-be', from: 'sb', to: 'be', kind: 'ro', bend: 26 },
    { id: 'be-sb', from: 'be', to: 'sb', kind: 'rw', bend: 26 },
    { id: 'be-wal', from: 'be', to: 'walbuf', kind: 'repl' },
    { id: 'wal-file', from: 'walbuf', to: 'walfile', kind: 'repl', label: 'flush' },
    { id: 'sb-os', from: 'sb', to: 'os', kind: 'rw', bend: 22 },
    { id: 'os-sb', from: 'os', to: 'sb', kind: 'ro', bend: 22 },
    { id: 'os-data', from: 'os', to: 'data', kind: 'rw', bend: 18 },
    { id: 'data-os', from: 'data', to: 'os', kind: 'ro', bend: 18 },
    { id: 'bgw-sb', from: 'bgw', to: 'sb', kind: 'ctrl', bend: -16 },
    { id: 'ckpt-sb', from: 'ckpt', to: 'sb', kind: 'ctrl', bend: 16 },
  ],

  steps: [
    {
      title: '버퍼 히트',
      note: 'SELECT가 orders 테이블 12번 블록을 찾습니다.\n해시에서 바로 찾았으므로 디스크 I/O 없이 슬롯에서 읽습니다.\n읽는 동안 PIN을 걸어 다른 프로세스가 내보내지 못하게 하고, usage_count를 1 올립니다(최대 5).',
      hand: { sb: 4 },
      slots: {
        sb: [
          S('orders:12', 4, { pin: true, hl: 'hit' }),
          S('users:5', 1),
          S('orders:13', 2, { dirty: true }),
          S('idx_ord:2', 5),
          S('items:40', 1, { dirty: true }),
          S('users:9', 2),
          S('orders:7', 0),
          S('items:41', 4),
        ],
      },
      callouts: [{ node: 'hash', text: '히트 → 슬롯 0', tone: 'ok' }],
      nodeNotes: {
        be: 'orders:12를 요청하고, 찾은 슬롯에 PIN을 건 채 읽습니다.',
        hash: 'buffer tag로 슬롯 0을 바로 찾았습니다.',
        sb: '슬롯 0의 usage_count가 3에서 4로 올랐습니다. 자주 쓰일수록 교체에서 오래 살아남습니다.',
      },
      flows: [
        { edge: 'be-hash', rate: 1.2, size: 4 },
        { edge: 'hash-sb', rate: 1.2, size: 4 },
        { edge: 'sb-be', rate: 1.4 },
      ],
    },
    {
      title: '미스와 클럭 스윕',
      note: '이번에는 users 테이블 77번 블록이 필요한데 해시에 없습니다(미스).\n클럭 바늘이 슬롯을 돌며 내보낼 칸을 고릅니다.\n· usage_count가 0보다 크면 1 깎고 지나갑니다.\n· 0이고 PIN이 없으면 그 칸을 고릅니다.\n고른 칸이 dirty라면 먼저 디스크에 써야 하는데, 이번 칸(orders:7)은 깨끗합니다.',
      hand: { sb: 6 },
      sweep: { node: 'sb', path: [4, 5, 6], every: 1000 },
      slots: {
        sb: [
          S('orders:12', 4),
          S('users:5', 1),
          S('orders:13', 2, { dirty: true }),
          S('idx_ord:2', 5),
          S('items:40', [1, 0], { dirty: true, hl: [null, 'skip'] }),
          S('users:9', [2, 1], { hl: [null, 'skip'] }),
          S('orders:7', 0, { hl: [null, 'victim'] }),
          S('items:41', 4),
        ],
      },
      callouts: [{ node: 'hash', text: '미스: users:77 없음', tone: 'warn' }],
      nodeNotes: {
        hash: 'users:77에 해당하는 항목이 없습니다.',
        sb: '바늘이 4번(1→0), 5번(2→1)을 깎고 지나가 6번(usage_count 0)을 희생 칸으로 골랐습니다.',
        be: '빈 칸이 정해질 때까지 기다립니다. 희생 칸이 dirty였다면 여기서 직접 쓰기까지 해야 합니다.',
      },
      flows: [{ edge: 'be-hash', rate: 1.2, size: 4 }],
    },
    {
      title: '디스크에서 읽어 오기',
      note: '골라 둔 6번 칸에 users:77을 읽어 옵니다.\nOS 페이지 캐시에 있으면 디스크까지 가지 않고, 없으면 데이터 파일에서 읽습니다.\n해시에 새 위치를 등록하고, 새 페이지는 usage_count 1로 시작합니다.',
      hand: { sb: 7 },
      slots: {
        sb: [
          S('orders:12', 4),
          S('users:5', 1),
          S('orders:13', 2, { dirty: true }),
          S('idx_ord:2', 5),
          S('items:40', 0, { dirty: true }),
          S('users:9', 1),
          S('users:77', 1, { pin: true, hl: 'load' }),
          S('items:41', 4),
        ],
      },
      callouts: [{ node: 'os', text: '캐시 미스면 디스크까지', tone: 'info', below: true }],
      nodeNotes: {
        os: '커널 캐시에 있으면 여기서 바로 돌려주고, 없으면 디스크에서 읽습니다.',
        data: 'users 파일의 77번 블록(8KB)을 읽습니다.',
        hash: 'users:77 → 슬롯 6을 등록합니다.',
        sb: '6번 칸이 users:77로 바뀌었습니다. usage_count 1에서 시작합니다.',
      },
      flows: [
        { edge: 'data-os', rate: 1 },
        { edge: 'os-sb', rate: 1 },
        { edge: 'hash-sb', rate: 0.8, size: 4 },
        { edge: 'sb-be', rate: 1 },
      ],
    },
    {
      title: '페이지 변경 (UPDATE)',
      note: 'users:77의 행을 UPDATE합니다.\n먼저 변경 내용을 WAL 레코드로 WAL 버퍼에 넣고, 그다음 버퍼의 페이지를 고칩니다.\n페이지는 dirty가 되고, 데이터 파일은 아직 그대로입니다.\n체크포인트 이후 이 페이지의 첫 변경이면 페이지 전체 이미지(FPW)도 WAL에 함께 실립니다.',
      slots: {
        sb: [
          S('orders:12', 4),
          S('users:5', 1),
          S('orders:13', 2, { dirty: true }),
          S('idx_ord:2', 5),
          S('items:40', 0, { dirty: true }),
          S('users:9', 1),
          S('users:77', 2, { pin: true, dirty: true, hl: 'write' }),
          S('items:41', 4),
        ],
      },
      callouts: [{ node: 'walbuf', text: 'WAL 레코드 추가', tone: 'info', below: true }],
      nodeNotes: {
        be: 'WAL 레코드를 만들고 페이지를 고칩니다. 페이지에는 이 WAL 위치(LSN)가 적힙니다.',
        walbuf: 'UPDATE의 WAL 레코드가 쌓입니다. 아직 디스크에는 없습니다.',
        sb: '6번 칸이 dirty가 되었습니다. 메모리의 페이지만 최신이고 데이터 파일은 옛 내용입니다.',
      },
      flows: [
        { edge: 'be-wal', rate: 1.4 },
        { edge: 'be-sb', rate: 1.4 },
      ],
    },
    {
      title: 'COMMIT = WAL flush',
      note: 'COMMIT 시점에 디스크로 확실히 내려가는 것은 WAL뿐입니다.\nWAL 파일이 fsync되면 커밋이 확정됩니다. dirty 페이지는 여전히 메모리에만 있습니다.\n여기서 서버가 죽어도 WAL을 재생해 페이지를 다시 만들 수 있습니다.\nsynchronous_commit=off면 이 flush를 walwriter가 나중에 하므로 짧은 구간의 커밋이 유실될 수 있습니다(데이터 깨짐은 없음).',
      slots: {
        sb: [
          S('orders:12', 4),
          S('users:5', 1),
          S('orders:13', 2, { dirty: true }),
          S('idx_ord:2', 5),
          S('items:40', 0, { dirty: true }),
          S('users:9', 1),
          S('users:77', 2, { dirty: true }),
          S('items:41', 4),
        ],
      },
      callouts: [{ node: 'walfile', text: 'fsync → 커밋 확정', tone: 'ok', below: true }],
      nodeNotes: {
        walbuf: '커밋 레코드까지 WAL 파일로 내보냅니다.',
        walfile: 'fsync가 끝나면 클라이언트에 COMMIT 성공을 돌려줍니다.',
        sb: '6번 칸은 dirty 그대로 남습니다. 데이터 파일 쓰기는 나중 일입니다.',
      },
      flows: [{ edge: 'wal-file', rate: 1.8 }],
    },
    {
      title: 'bgwriter의 미리 청소',
      note: 'bgwriter가 바늘보다 앞서 돌면서 곧 교체될 dirty 버퍼를 커널로 내보냅니다.\n대상은 usage_count 0 · PIN 없음 · dirty인 칸뿐입니다. 4번(items:40)이 해당되어 깨끗해졌습니다.\n2번·6번은 usage_count가 남아 있어 건너뜁니다.\n쓰기 전에는 그 페이지 LSN까지 WAL이 flush됐는지 확인합니다(WAL 우선 규칙).',
      slots: {
        sb: [
          S('orders:12', 4),
          S('users:5', 1),
          S('orders:13', 2, { dirty: true }),
          S('idx_ord:2', 5),
          S('items:40', 0, { hl: 'write' }),
          S('users:9', 1),
          S('users:77', 2, { dirty: true }),
          S('items:41', 4),
        ],
      },
      callouts: [{ node: 'bgw', text: 'uc 0 + dirty만 청소', tone: 'info', below: true }],
      nodeNotes: {
        bgw: 'items:40(usage_count 0, dirty)을 write()로 커널에 넘겼습니다. fsync는 체크포인트에 맡깁니다.',
        sb: '4번 칸이 깨끗해져, 다음 교체 때 백엔드가 쓰기 없이 바로 재사용할 수 있습니다.',
        os: '페이지가 커널 캐시에 들어갔습니다. 아직 디스크 fsync 전입니다.',
      },
      flows: [
        { edge: 'bgw-sb', rate: 1, size: 4 },
        { edge: 'sb-os', rate: 1 },
      ],
    },
    {
      title: '체크포인트',
      note: 'checkpointer가 남은 dirty 버퍼(2번, 6번)를 모두 쓰고 fsync합니다.\ncheckpoint_completion_target에 맞춰 다음 체크포인트까지 시간에 나눠 쓰므로 I/O가 한 번에 몰리지 않습니다.\n끝나면 redo 지점이 앞으로 당겨지고, 그 이전 WAL 세그먼트는 재활용할 수 있습니다.',
      slots: {
        sb: [
          S('orders:12', 4),
          S('users:5', 1),
          S('orders:13', 2, { hl: 'write' }),
          S('idx_ord:2', 5),
          S('items:40', 0),
          S('users:9', 1),
          S('users:77', 2, { hl: 'write' }),
          S('items:41', 4),
        ],
      },
      callouts: [{ node: 'data', text: 'fsync', tone: 'ok', below: true }],
      nodeNotes: {
        ckpt: 'dirty 버퍼 전체를 시간에 나눠 쓰고 fsync한 뒤 체크포인트 레코드를 WAL에 남깁니다.',
        sb: '모든 칸이 깨끗합니다. usage_count는 그대로라 캐시 내용은 유지됩니다.',
        data: '이제 데이터 파일이 메모리 내용과 같아졌습니다.',
        walfile: 'redo 지점 이전 세그먼트는 지우거나 재활용할 수 있습니다.',
      },
      flows: [
        { edge: 'ckpt-sb', rate: 1, size: 4 },
        { edge: 'sb-os', rate: 1.4 },
        { edge: 'os-data', rate: 1.4 },
      ],
    },
  ],
});
