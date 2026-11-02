// SQL Server Always On AG — 큰 트랜잭션이 SECONDARY redo를 밀리게 하고, 그 밀림이 페일오버 뒤 DB 오픈을 늦추는 원리
// 근거: Microsoft Learn(Failover and failover modes for AGs, sys.dm_hadr_database_replica_states, Accelerated Database Recovery)
// 슬롯 색: 초록=redo 적용 완료 · 파랑=받아서 디스크에 기록(harden)했지만 아직 적용 전 · 주황=지금 적용 중 · 빨강 점선=미커밋(undo 대상)
const S = (p, sub, hl) => ({ p, sub, hl });
const PRI = (resp, queue = []) => [
  S('로그 생성', '로그 버퍼'), S('로컬 flush', 'LDF 디스크'), S('커밋 응답', 'COMMIT OK', resp),
  ...[0, 1, 2].map((i) => queue[i] || S('보낼 로그', '비어 있음')),
];
const DONE = (lsn) => S(lsn, 'redo 완료', 'hit');
const NOW = (lsn) => S(lsn, '적용 중', 'write');
const WAIT = (lsn) => S(lsn, '적용 대기', 'load');
const UNDO = (lsn) => S(lsn, '미커밋→undo', 'victim');

ArchMotion.scenario({
  title: 'SQL Server AG redo 밀림과 페일오버',
  summary: '대량 배치나 인덱스 작업이 로그를 한꺼번에 만들면 SECONDARY는 로그를 받기는 해도 적용(redo)은 뒤처집니다. 그 밀림이 페일오버 뒤 DB가 늦게 열리는 이유가 되는 과정을 보여 줍니다.',
  disclaimer: '일반 동작 설명 · 동기 커밋(SYNCHRONOUS_COMMIT) 2노드 기준',
  width: 1180,
  height: 640,

  kindNames: { rw: '앱 요청', ro: '응답', repl: '로그 전송·redo 적용', ctrl: 'harden 확인(ack)' },

  groups: [
    { label: '접속 경로', x: 20, y: 60, w: 300, h: 500, tone: 'app' },
    { label: 'PRIMARY 노드', x: 340, y: 60, w: 340, h: 500, tone: 'db' },
    { label: 'SECONDARY 노드', x: 720, y: 40, w: 440, h: 580, tone: 'db' },
  ],

  nodes: [
    {
      id: 'app', label: '애플리케이션', sub: '쓰기·읽기 요청', x: 170, y: 170, kind: 'app',
      role: '리스너로 접속해 쿼리를 보냅니다. COMMIT 응답을 받으면 저장됐다고 믿습니다.',
      notes: ['노드 IP로 직접 붙으면 페일오버 뒤에도 옛 노드로 갑니다. 리스너 사용이 기본입니다.'],
    },
    {
      id: 'lsn', label: 'AG 리스너', sub: '현재 PRIMARY로', x: 170, y: 420, kind: 'lb',
      role: 'AG의 가상 이름·IP입니다. 항상 현재 PRIMARY를 가리킵니다.',
      details: [['페일오버 시', '새 PRIMARY로 자동 전환 (앱은 재접속 필요)']],
    },
    {
      id: 'pri', label: 'PRIMARY', sub: '쓰기 처리 · 로그 생성', x: 510, y: 300, w: 310, h: 210, kind: 'db',
      slots: { cols: 3, w: 92, h: 50 },
      role: '변경을 트랜잭션 로그로 먼저 기록하고, 그 로그를 SECONDARY로 보냅니다. 동기 커밋이면 SECONDARY가 로그를 디스크에 기록(harden)했다는 확인까지 받은 뒤 COMMIT 응답을 줍니다.',
      details: [
        ['보낼 로그 대기량', 'log_send_queue_size (KB)'],
        ['DMV', 'sys.dm_hadr_database_replica_states'],
        ['perfmon', 'SQLServer:Database Replica — Log Send Queue'],
      ],
      notes: [
        '아래 줄 "보낼 로그"가 log send queue입니다. 동기 커밋이면 평소 거의 0입니다.',
        '동기 커밋이 기다리는 건 harden(디스크 기록)까지입니다. redo(적용)는 기다리지 않습니다.',
      ],
    },
    {
      id: 'sec', label: 'SECONDARY', sub: '로그 수신 · redo', x: 940, y: 270, w: 400, h: 220, kind: 'db',
      slots: { cols: 4, w: 84, h: 48, empty: '빈 칸' },
      role: '받은 로그를 먼저 자기 로그 파일에 기록(harden)하고 ack를 보냅니다. 그다음 redo 스레드가 로그를 하나씩 데이터 페이지에 적용합니다.',
      details: [
        ['적용 대기량', 'redo_queue_size (KB)'],
        ['적용 속도', 'redo_rate (KB/s)'],
        ['예상 소요', 'redo_queue_size ÷ redo_rate ≈ 페일오버 후 DB가 열리기까지 걸리는 시간'],
        ['perfmon', 'SQLServer:Database Replica — Recovery Queue, Redo Bytes Remaining'],
      ],
      notes: [
        '파랑 칸(받았지만 적용 전)이 redo queue입니다.',
        'synchronization_state가 SYNCHRONIZED여도 redo queue는 클 수 있습니다.',
      ],
    },
    {
      id: 'data', label: '데이터 파일', sub: 'SECONDARY MDF/NDF', x: 940, y: 540, kind: 'store',
      role: 'redo가 로그 내용을 실제 데이터 페이지에 반영하는 곳입니다.',
      notes: ['redo는 대상 페이지를 읽어서 고쳐야 하므로 랜덤 I/O가 많습니다. 로그 수신(순차 쓰기)보다 느리기 쉽습니다.'],
    },
  ],

  edges: [
    { id: 'app-lsn', from: 'app', to: 'lsn', kind: 'rw', fromSide: 'bottom', toSide: 'top' },
    { id: 'lsn-pri', from: 'lsn', to: 'pri', kind: 'rw', fromSide: 'right', toSide: 'left' },
    { id: 'lsn-sec', from: 'lsn', to: 'sec', kind: 'rw', fromSide: 'bottom', toSide: 'left', bend: 300, hidden: true },
    { id: 'pri-sec', from: 'pri', to: 'sec', kind: 'repl', bend: 14 },
    { id: 'sec-pri', from: 'sec', to: 'pri', kind: 'ctrl', bend: 14 },
    { id: 'sec-data', from: 'sec', to: 'data', kind: 'repl', fromSide: 'bottom', toSide: 'top' },
  ],

  steps: [
    {
      title: '평소: 작은 트랜잭션',
      note: '트랜잭션이 작으면 로그도 조금씩 생깁니다.\nPRIMARY는 로그를 flush하고 SECONDARY로 보냅니다.\nSECONDARY는 받은 로그를 디스크에 기록(harden)하고 ack를 보낸 뒤, 거의 바로 redo로 적용합니다.\n보낼 로그도, 적용 대기 로그도 거의 0입니다.',
      slots: {
        pri: PRI('hit'),
        sec: [DONE('LSN 101'), DONE('LSN 102'), NOW('LSN 103'), {}, {}, {}, {}, {}],
      },
      callouts: [{ node: 'sec', text: 'redo queue ≈ 0', tone: 'ok', below: true }],
      nodeNotes: {
        pri: 'SECONDARY의 harden ack를 받고 COMMIT 응답을 줍니다.',
        sec: '받자마자 적용합니다. 밀림이 없습니다.',
      },
      flows: [
        { edge: 'app-lsn', rate: 1 }, { edge: 'lsn-pri', rate: 1 },
        { edge: 'pri-sec', rate: 1 }, { edge: 'sec-pri', rate: 1, size: 4 },
        { edge: 'sec-data', rate: 1 },
      ],
    },
    {
      title: '대량 배치 시작: 로그 폭증',
      note: '수백만 건 UPDATE, 인덱스 재구성 같은 작업은 짧은 시간에 로그를 대량으로 만듭니다.\n행 하나 바꿀 때마다 로그 레코드가 생기고, 인덱스가 많으면 그 배수로 늘어납니다.\nPRIMARY의 "보낼 로그"가 잠깐 차고, SECONDARY로 로그가 몰려 들어갑니다.',
      states: { pri: 'busy' },
      slots: {
        pri: PRI(null, [S('LSN 2xx', '전송 대기', 'load'), S('LSN 3xx', '전송 대기', 'load'), S('LSN 4xx', '전송 대기', 'load')]),
        sec: [DONE('LSN 101'), DONE('LSN 102'), NOW('LSN 103'), WAIT('LSN 104'), WAIT('LSN 105'), WAIT('LSN 106'), {}, {}],
      },
      callouts: [{ node: 'pri', text: '로그 대량 생성', tone: 'warn', below: true }],
      nodeNotes: {
        pri: '로그 생성 속도가 전송·적용 속도를 넘어서기 시작합니다.',
        sec: '들어오는 속도를 redo가 못 따라가기 시작합니다.',
      },
      flows: [
        { edge: 'app-lsn', rate: 2.2 }, { edge: 'lsn-pri', rate: 2.2 },
        { edge: 'pri-sec', rate: 2.6 }, { edge: 'sec-pri', rate: 2, size: 4 },
        { edge: 'sec-data', rate: 0.6 },
      ],
    },
    {
      title: 'SYNCHRONIZED인데 redo는 밀림',
      note: '동기 커밋이 기다리는 건 "SECONDARY가 로그를 디스크에 기록했다(harden)"까지입니다.\n그래서 보낼 로그는 금방 비고, 상태도 SYNCHRONIZED로 보입니다.\n하지만 redo(적용)는 별도로 천천히 진행됩니다. 받기만 하고 적용 안 된 로그가 redo queue에 쌓입니다.\n"동기화 완료"와 "적용 완료"는 다른 말입니다.',
      states: { pri: 'normal' },
      slots: {
        pri: PRI('hit'),
        sec: [DONE('LSN 101'), DONE('LSN 102'), DONE('LSN 103'), NOW('LSN 104'), WAIT('LSN 2xx'), WAIT('LSN 3xx'), WAIT('LSN 4xx'), WAIT('LSN 5xx')],
      },
      callouts: [
        { node: 'pri', text: 'SYNCHRONIZED', tone: 'ok', below: true },
        { node: 'sec', text: 'redo queue 4칸 쌓임', tone: 'warn' },
      ],
      nodeNotes: {
        pri: 'log_send_queue_size ≈ 0, synchronization_state = SYNCHRONIZED.',
        sec: 'redo_queue_size가 커지고 있습니다. 파랑 칸이 그것입니다.',
      },
      flows: [
        { edge: 'app-lsn', rate: 2 }, { edge: 'lsn-pri', rate: 2 },
        { edge: 'pri-sec', rate: 2.2 }, { edge: 'sec-pri', rate: 2, size: 4 },
        { edge: 'sec-data', rate: 0.5 },
      ],
    },
    {
      title: 'redo가 느린 이유',
      note: '로그 받기는 순차 쓰기라 빠르지만, redo는 고칠 데이터 페이지를 찾아 읽고 써야 해서 느립니다.\n흔한 원인:\n· 대상 페이지가 메모리에 없어 디스크에서 읽어야 함(랜덤 I/O)\n· 같은 디스크에서 백업 등 다른 I/O와 경합\n· 읽기 가능 SECONDARY에서 돌던 쿼리가 DDL redo를 막음(스키마 락)\n· redo 스레드 수 한계',
      states: { sec: 'busy', data: 'busy' },
      slots: {
        sec: [DONE('LSN 101'), DONE('LSN 102'), DONE('LSN 103'), DONE('LSN 104'), NOW('LSN 2xx'), WAIT('LSN 3xx'), WAIT('LSN 4xx'), WAIT('LSN 5xx')],
      },
      callouts: [{ node: 'data', text: '페이지 읽기·쓰기 대기', tone: 'warn', below: true }],
      nodeNotes: {
        sec: 'redo_rate(KB/s)가 들어오는 속도보다 낮으면 queue는 계속 커집니다.',
        data: 'redo 한 건마다 페이지를 읽어서 고칩니다. 디스크가 바쁘면 그만큼 느려집니다.',
      },
      flows: [
        { edge: 'pri-sec', rate: 1.8 }, { edge: 'sec-pri', rate: 1.6, size: 4 },
        { edge: 'sec-data', rate: 0.4 },
      ],
    },
    {
      title: '이 상태에서 페일오버',
      note: '리스너가 SECONDARY를 새 PRIMARY로 가리킵니다.\n그런데 새 PRIMARY는 redo queue에 남은 로그를 끝까지 적용해야 DB를 열 수 있습니다.\n그동안 접속하면 "복제본이 PRIMARY 또는 SECONDARY 역할에 있지 않다"(MonETC 유형) 또는 "DB를 열 수 없다" 오류가 납니다.\n걸리는 시간 ≈ redo_queue_size ÷ redo_rate.',
      states: { pri: 'down', sec: 'recovering', data: 'busy' },
      labels: { sec: '새 PRIMARY', lsn: 'AG 리스너' },
      subs: { sec: 'redo 마무리 중 · DB 닫힘', lsn: '새 PRIMARY로' },
      edges: { 'lsn-pri': 'off', 'pri-sec': 'off', 'sec-pri': 'off', 'lsn-sec': 'on' },
      slots: {
        sec: [DONE('LSN 101'), DONE('LSN 102'), DONE('LSN 103'), DONE('LSN 104'), DONE('LSN 2xx'), NOW('LSN 3xx'), WAIT('LSN 4xx'), WAIT('LSN 5xx')],
      },
      callouts: [
        { node: 'sec', text: '남은 redo 끝나야 DB 열림', tone: 'warn' },
        { node: 'app', text: '접속 오류', tone: 'warn', below: true },
      ],
      nodeNotes: {
        sec: '역할은 PRIMARY지만 DB는 아직 복구 중입니다. 밀린 양만큼 기다려야 합니다.',
        app: '오류 → 재시도. 커넥션 풀이 끊긴 연결을 들고 있으면 열린 뒤에도 오류가 남을 수 있습니다.',
      },
      flows: [
        { edge: 'app-lsn', rate: 1.6 }, { edge: 'lsn-sec', rate: 1.6, fail: true },
        { edge: 'sec-data', rate: 0.8 },
      ],
      hold: 9000,
    },
    {
      title: 'redo 완료 → DB 열림, undo는 뒤에서',
      note: 'redo가 끝나면 DB가 열리고 앱 요청이 들어옵니다.\n페일오버 순간 끝나지 않았던 트랜잭션(빨강 점선)은 되돌려야 합니다(undo).\nAG에서는 이 undo를 락을 잡은 채 백그라운드로 진행합니다. 그 행을 건드리는 쿼리만 기다립니다.\nADR(가속 DB 복구, 2019+)을 켜 두면 undo가 거의 즉시 끝납니다.',
      states: { sec: 'promoted', data: 'normal' },
      subs: { sec: 'DB ONLINE · 쓰기 처리' },
      slots: {
        sec: [DONE('LSN 101'), DONE('LSN 102'), DONE('LSN 103'), DONE('LSN 104'), DONE('LSN 2xx'), DONE('LSN 3xx'), UNDO('LSN 4xx'), UNDO('LSN 5xx')],
      },
      callouts: [
        { node: 'sec', text: 'DB 열림', tone: 'ok' },
        { node: 'data', text: '미커밋분 undo (백그라운드)', tone: 'info', below: true },
      ],
      nodeNotes: {
        sec: '에러로그에 DB별 복구 진행·완료 메시지가 남습니다. 어느 단계가 오래 걸렸는지 판단 근거가 됩니다.',
        data: '롤백 대상 행에는 락이 걸려 있어, 그 행을 쓰려는 쿼리만 잠깐 기다립니다.',
      },
      flows: [
        { edge: 'app-lsn', rate: 1.2 }, { edge: 'lsn-sec', rate: 1.2 },
        { edge: 'sec-data', rate: 1 },
      ],
    },
    {
      title: '다음 페일오버 전 확인',
      note: '계획 페일오버라면 넘기기 직전에 확인합니다.\n· 모든 DB가 SYNCHRONIZED인지\n· redo_queue_size가 0에 가까운지(크면 ÷ redo_rate로 예상 시간 계산)\n· 큰 배치·인덱스 작업·롱 트랜잭션이 돌고 있지 않은지\n급하면: 새 로그를 만드는 작업부터 멈추고 queue가 줄어드는 걸 보며 넘깁니다. 이미 도는 큰 트랜잭션을 KILL하면 PRIMARY에서 롤백이 또 오래 걸릴 수 있어 신중해야 합니다.',
      states: { pri: 'normal', sec: 'normal', data: 'normal' },
      labels: { sec: 'SECONDARY' },
      subs: { sec: '로그 수신 · redo', lsn: '현재 PRIMARY로' },
      edges: { 'lsn-pri': 'on', 'pri-sec': 'on', 'sec-pri': 'on', 'lsn-sec': 'off' },
      slots: {
        pri: PRI('hit'),
        sec: [DONE('LSN 6xx'), DONE('LSN 6xx'), DONE('LSN 7xx'), DONE('LSN 7xx'), {}, {}, {}, {}],
      },
      callouts: [{ node: 'sec', text: 'redo queue ≈ 0 → 넘겨도 됨', tone: 'ok', below: true }],
      nodeNotes: {
        pri: 'log_send_queue_size ≈ 0, 큰 작업 없음.',
        sec: 'redo_queue_size ≈ 0. 이 상태면 페일오버 후 DB가 몇 초 안에 열립니다.',
      },
      flows: [
        { edge: 'app-lsn', rate: 1 }, { edge: 'lsn-pri', rate: 1 },
        { edge: 'pri-sec', rate: 1 }, { edge: 'sec-pri', rate: 1, size: 4 },
        { edge: 'sec-data', rate: 1 },
      ],
    },
  ],
});
