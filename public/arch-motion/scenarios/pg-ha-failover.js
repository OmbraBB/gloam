// 샘플: PostgreSQL Primary/Standby 페일오버 일반 패턴
// 실제 호스트·IP·포트·계정은 넣지 않는다. 노드 이름은 역할명만 쓴다.
ArchMotion.scenario({
  title: 'PostgreSQL 페일오버 흐름',
  summary: '쓰기·읽기 엔드포인트 뒤의 Primary/Standby 구성에서 Primary 장애가 나면 요청과 복제가 어떻게 바뀌는지 단계별로 보여줍니다.',
  disclaimer: '일반 패턴 샘플 · 실제 운영 구성과 다를 수 있음',
  width: 1080,
  height: 560,

  groups: [
    { label: '애플리케이션', x: 20, y: 60, w: 200, h: 460, tone: 'app' },
    { label: '접속 계층', x: 290, y: 60, w: 200, h: 460, tone: 'proxy' },
    { label: 'DB 클러스터', x: 600, y: 60, w: 220, h: 460, tone: 'db' },
    { label: '제어', x: 880, y: 60, w: 180, h: 460, tone: 'ctrl' },
  ],

  nodes: [
    {
      id: 'app', label: '애플리케이션', sub: '서비스 파드', x: 120, y: 290, kind: 'app',
      role: 'DB에 쓰기·읽기 요청을 보내는 서비스입니다. 쓰기와 읽기를 서로 다른 엔드포인트로 나눠 보내고, DB 노드의 실제 주소는 알지 못합니다.',
      details: [
        ['접속 대상', '쓰기 엔드포인트 / 읽기 엔드포인트'],
        ['필요 기능', '재연결·재시도, 커넥션 타임아웃'],
      ],
      notes: [
        '페일오버 순간 커넥션이 끊깁니다. 재시도가 없으면 오류가 그대로 사용자에게 보입니다.',
        '쓰기 직후 읽기 엔드포인트로 같은 데이터를 읽으면 복제 지연 때문에 이전 값이 보일 수 있습니다.',
      ],
    },
    {
      id: 'rw', label: '쓰기 엔드포인트', sub: 'PgBouncer / LB', x: 390, y: 180, kind: 'proxy',
      role: '쓰기 요청을 현재 Primary 한 대로 보내는 단일 진입점입니다. Primary가 바뀌어도 앱은 이 주소만 알면 됩니다.',
      details: [
        ['구성 예', 'PgBouncer(커넥션 풀) + LB/VIP'],
        ['라우팅 기준', '현재 Primary 1대'],
        ['풀링 모드', 'transaction 또는 session'],
      ],
      notes: [
        'Primary 판별은 HA 매니저의 상태 정보나 pg_is_in_recovery() 응답으로 합니다.',
        'transaction 풀링에서는 세션 상태(SET, advisory lock 등)에 기대는 기능이 제한됩니다.',
      ],
    },
    {
      id: 'ro', label: '읽기 엔드포인트', sub: 'PgBouncer / LB', x: 390, y: 400, kind: 'proxy',
      role: '읽기 전용 요청을 Standby로 보내 Primary의 부하를 덜어 줍니다.',
      details: [
        ['라우팅 기준', 'Standby (여러 대면 분산)'],
        ['Standby 없을 때', 'Primary로 우회 또는 실패 — 구성에 따라 다름'],
      ],
      notes: [
        'Standby의 데이터는 복제 지연만큼 늦습니다. 정합성이 중요한 읽기는 쓰기 엔드포인트로 보냅니다.',
      ],
    },
    {
      id: 'pg1', label: 'Primary', sub: 'pg-node-1', x: 710, y: 180, kind: 'db',
      role: '쓰기를 받는 유일한 노드입니다. 변경 내용을 WAL에 기록하고 Standby로 전송합니다.',
      details: [
        ['역할', 'Primary (read-write)'],
        ['복제 방식', '스트리밍 복제 (물리)'],
        ['역할 확인', 'SELECT pg_is_in_recovery() → false'],
        ['복제 상태', 'pg_stat_replication'],
      ],
      notes: [
        'synchronous_commit·synchronous_standby_names 설정에 따라 장애 시 유실 범위(RPO)가 달라집니다.',
        '복제 슬롯을 쓰면 Standby가 오래 끊겼을 때 WAL이 쌓여 디스크가 찰 수 있습니다.',
      ],
    },
    {
      id: 'pg2', label: 'Standby', sub: 'pg-node-2', x: 710, y: 400, kind: 'db',
      role: 'Primary의 WAL을 받아 그대로 재생하는 복제본입니다. 평소에는 읽기를 처리하고, 장애 시 Primary로 승격됩니다.',
      details: [
        ['역할', 'Standby (hot standby, read-only)'],
        ['역할 확인', 'SELECT pg_is_in_recovery() → true'],
        ['지연 확인', 'Primary의 pg_stat_replication.replay_lag'],
      ],
      notes: [
        '승격 후에는 읽기와 쓰기를 모두 받으므로 Primary와 같은 사양이어야 안전합니다.',
        'Standby의 긴 쿼리는 복제 재생과 충돌해 취소될 수 있습니다(hot_standby_feedback, max_standby_streaming_delay).',
      ],
    },
    {
      id: 'ha', label: 'HA 매니저', sub: 'Patroni·repmgr 등', x: 970, y: 290, w: 160, kind: 'ctrl',
      role: '노드 상태를 주기적으로 확인하고, Primary 장애가 확정되면 Standby 승격과 경로 전환을 지휘합니다.',
      details: [
        ['도구 예', 'Patroni(+etcd/Consul), repmgr, pg_auto_failover'],
        ['판단 기준', '헬스체크 실패 횟수 × 확인 간격'],
        ['핵심 책임', 'Primary가 둘이 되지 않게 막기(split-brain 방지)'],
      ],
      notes: [
        '판정이 너무 빠르면 짧은 네트워크 흔들림에도 불필요한 페일오버가 일어납니다.',
        'HA 매니저 자체를 이중화하지 않으면 이것이 단일 장애점이 됩니다.',
      ],
    },
  ],

  edges: [
    { id: 'app-rw', from: 'app', to: 'rw', kind: 'rw' },
    { id: 'app-ro', from: 'app', to: 'ro', kind: 'ro' },
    { id: 'rw-pg1', from: 'rw', to: 'pg1', kind: 'rw' },
    { id: 'rw-pg2', from: 'rw', to: 'pg2', kind: 'rw', bend: 30, hidden: true },
    { id: 'ro-pg2', from: 'ro', to: 'pg2', kind: 'ro' },
    { id: 'ro-pg1', from: 'ro', to: 'pg1', kind: 'ro', bend: 30, hidden: true },
    { id: 'rep-12', from: 'pg1', to: 'pg2', kind: 'repl', bend: 40, label: 'WAL' },
    { id: 'rep-21', from: 'pg2', to: 'pg1', kind: 'repl', bend: 40, label: 'WAL', hidden: true },
    { id: 'ha-pg1', from: 'ha', to: 'pg1', kind: 'ctrl' },
    { id: 'ha-pg2', from: 'ha', to: 'pg2', kind: 'ctrl' },
  ],

  steps: [
    {
      title: '정상 운영',
      note: '쓰기는 쓰기 엔드포인트를 거쳐 Primary로 갑니다.\n읽기는 읽기 엔드포인트를 거쳐 Standby로 갑니다.\nPrimary의 변경분(WAL)은 Standby로 계속 전송됩니다.\nHA 매니저는 두 노드의 상태를 주기적으로 확인합니다.',
      nodeNotes: {
        pg1: '쓰기를 처리하고 WAL을 Standby로 보냅니다.',
        pg2: 'WAL을 재생하면서 읽기 요청을 처리합니다.',
        ha: '두 노드에 주기적으로 헬스체크를 보냅니다.',
      },
      flows: [
        { edge: 'app-rw', rate: 1.6 },
        { edge: 'rw-pg1', rate: 1.6 },
        { edge: 'app-ro', rate: 1.2 },
        { edge: 'ro-pg2', rate: 1.2 },
        { edge: 'rep-12', rate: 2.2, size: 4 },
        { edge: 'ha-pg1', rate: 0.5, size: 3.5 },
        { edge: 'ha-pg2', rate: 0.5, size: 3.5 },
      ],
    },
    {
      title: 'Primary 장애',
      note: 'Primary가 응답하지 않아 쓰기 요청이 실패합니다.\n읽기는 Standby에서 계속 처리됩니다.\n비동기 복제라면 아직 전송되지 못한 마지막 변경분은 유실될 수 있습니다(RPO).',
      states: { pg1: 'down' },
      edges: { 'rep-12': 'dim' },
      callouts: [{ node: 'pg1', text: '응답 없음', tone: 'warn' }],
      nodeNotes: {
        pg1: '프로세스 중단이나 네트워크 단절로 응답하지 않습니다.',
        rw: 'Primary로 보낸 쓰기 요청이 실패합니다.',
        pg2: '읽기는 계속 처리합니다. 마지막 WAL 일부를 받지 못했을 수 있습니다.',
        ha: 'pg-node-1의 헬스체크 실패를 세고 있습니다. 아직 장애로 확정하지 않았습니다.',
        app: '쓰기 오류를 받기 시작합니다.',
      },
      flows: [
        { edge: 'app-rw', rate: 1.6 },
        { edge: 'rw-pg1', rate: 1.6, fail: true },
        { edge: 'app-ro', rate: 1.2 },
        { edge: 'ro-pg2', rate: 1.2 },
        { edge: 'ha-pg1', rate: 0.8, size: 3.5, fail: true },
        { edge: 'ha-pg2', rate: 0.5, size: 3.5 },
      ],
    },
    {
      title: '장애 확정과 승격',
      note: 'HA 매니저가 헬스체크 실패가 기준 횟수를 넘은 것을 보고 장애로 확정합니다.\nStandby를 Primary로 승격(promote)합니다.\n이 판단 시간(실패 횟수 × 확인 간격)이 다운타임의 대부분을 차지합니다.',
      states: { pg2: 'promoted' },
      labels: { pg1: '옛 Primary', pg2: 'Primary' },
      subs: { pg2: 'pg-node-2 (승격)' },
      callouts: [
        { node: 'ha', text: '장애 확정 → promote', tone: 'ok', below: true },
        { node: 'pg1', text: '응답 없음', tone: 'warn' },
      ],
      nodeNotes: {
        ha: '실패가 기준을 넘어 장애로 확정하고 pg-node-2에 promote를 실행합니다.',
        pg2: '복구 모드를 끝내고 쓰기 가능한 Primary가 됩니다. 새 타임라인이 시작됩니다.',
        pg1: '여전히 응답하지 않습니다. 이 노드가 다시 살아나도 Primary로 쓰이면 안 됩니다.',
        rw: '아직 옛 Primary를 가리키고 있어 쓰기 실패가 계속됩니다.',
      },
      flows: [
        { edge: 'app-rw', rate: 1.6 },
        { edge: 'rw-pg1', rate: 1.6, fail: true },
        { edge: 'app-ro', rate: 1.2 },
        { edge: 'ro-pg2', rate: 1.2 },
        { edge: 'ha-pg2', rate: 1.5, size: 4 },
      ],
    },
    {
      title: '쓰기 경로 전환',
      note: '쓰기 엔드포인트가 새 Primary를 가리키도록 바뀝니다.\n기존 커넥션은 끊기므로 앱에 재연결·재시도 로직이 있어야 합니다.\n이 시점에는 읽기와 쓰기가 한 노드에 몰리므로 부하를 지켜봐야 합니다.',
      states: { pg2: 'busy' },
      edges: { 'rw-pg1': 'off', 'rw-pg2': 'on', 'rep-12': 'off' },
      callouts: [{ node: 'pg2', text: '읽기 + 쓰기 집중', tone: 'warn', below: true }],
      nodeNotes: {
        rw: '라우팅 대상을 pg-node-2로 바꿉니다. 기존 커넥션은 끊깁니다.',
        pg2: '읽기와 쓰기를 모두 받습니다. CPU·커넥션 수를 지켜봐야 합니다.',
        app: '끊긴 커넥션을 재연결하고 실패한 쓰기를 재시도합니다.',
      },
      flows: [
        { edge: 'app-rw', rate: 1.6 },
        { edge: 'rw-pg2', rate: 1.6 },
        { edge: 'app-ro', rate: 1.2 },
        { edge: 'ro-pg2', rate: 1.2 },
        { edge: 'ha-pg2', rate: 0.5, size: 3.5 },
      ],
    },
    {
      title: '옛 Primary 재합류',
      note: '옛 Primary는 pg_rewind 또는 재복제로 Standby가 되어 다시 붙습니다.\n복구된 노드를 그대로 Primary로 띄우면 Primary가 둘이 되는 split-brain이 생기므로 HA 매니저가 이를 막아야 합니다.\n읽기 엔드포인트는 다시 Standby를 가리킵니다.',
      states: { pg1: 'normal', pg2: 'normal' },
      labels: { pg1: 'Standby' },
      subs: { pg1: 'pg-node-1 (재합류)', pg2: 'pg-node-2' },
      edges: { 'rep-21': 'on', 'ro-pg2': 'off', 'ro-pg1': 'on' },
      callouts: [{ node: 'pg1', text: 'Standby로 재합류', tone: 'ok' }],
      nodeNotes: {
        pg1: 'pg_rewind로 갈라진 타임라인을 맞춘 뒤 Standby로 다시 시작해 새 Primary의 WAL을 받습니다.',
        pg2: 'Primary로 쓰기를 처리하고 WAL을 pg-node-1로 보냅니다.',
        ro: '읽기 대상을 다시 Standby(pg-node-1)로 돌립니다.',
        ha: '두 노드를 다시 정상 감시합니다.',
      },
      flows: [
        { edge: 'app-rw', rate: 1.6 },
        { edge: 'rw-pg2', rate: 1.6 },
        { edge: 'app-ro', rate: 1.2 },
        { edge: 'ro-pg1', rate: 1.2 },
        { edge: 'rep-21', rate: 2.2, size: 4 },
        { edge: 'ha-pg1', rate: 0.5, size: 3.5 },
        { edge: 'ha-pg2', rate: 0.5, size: 3.5 },
      ],
    },
  ],
});
