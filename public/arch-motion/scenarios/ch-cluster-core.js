// ClickHouse 클러스터 코어 — 2샤드 × 2레플리카 + ClickHouse Keeper + Altinity clickhouse-operator 일반 패턴
// 근거: ClickHouse 공식 문서(Distributed 엔진, ReplicatedMergeTree, ClickHouse Keeper, MergeTree 파트)와
//      Altinity clickhouse-operator 문서(CHI/CHK 리소스, 호스트별 StatefulSet)
// 실제 호스트·포트·계정은 넣지 않는다. 파트 이름은 <파티션>_<최소블록>_<최대블록>_<머지레벨>.
const P = (p, sub, extra) => Object.assign({ p, sub }, extra);
const BASE = [P('all_1_1_0', '1만 행'), P('all_2_2_0', '1만 행'), {}];
const WITH3 = (hl) => [P('all_1_1_0', '1만 행'), P('all_2_2_0', '1만 행'), P('all_3_3_0', '1만 행', { hl })];
const MERGED = (hl) => [P('all_1_3_1', '3만 행', { hl }), {}, {}];

ArchMotion.scenario({
  title: 'ClickHouse 클러스터 코어',
  summary: '샤드·레플리카·Keeper·Distributed 테이블·오퍼레이터가 INSERT, 복제, 머지, 조회, 장애 때 각각 무슨 일을 하는지 단계별로 보여줍니다.',
  disclaimer: '일반 패턴 · 2샤드×2레플리카 예시 · 실제 운영 구성과 다를 수 있음',
  width: 1300,
  height: 720,

  kindNames: { rw: 'INSERT', ro: '조회 결과', repl: '파트 복제', ctrl: '조정·제어' },

  groups: [
    { label: '클라이언트', x: 20, y: 60, w: 190, h: 600, tone: 'app' },
    { label: '라우팅', x: 240, y: 60, w: 220, h: 600, tone: 'proxy' },
    { label: '샤드 1', x: 500, y: 50, w: 380, h: 310, tone: 'db' },
    { label: '샤드 2', x: 500, y: 390, w: 380, h: 310, tone: 'db' },
    { label: '컨트롤 플레인 (Kubernetes)', x: 930, y: 50, w: 350, h: 310, tone: 'ctrl' },
    { label: '복제 조정', x: 930, y: 390, w: 350, h: 310, tone: 'ctrl' },
  ],

  nodes: [
    {
      id: 'app', label: '애플리케이션', sub: '수집기·대시보드', x: 115, y: 360, kind: 'app',
      role: '데이터를 넣고(INSERT) 조회(SELECT)하는 쪽입니다. 수집 파이프라인, Grafana, 배치 작업 등이 여기에 해당합니다.',
      details: [
        ['INSERT 방식', 'Distributed 테이블 또는 각 샤드의 로컬 테이블'],
        ['권장 배치', '작은 INSERT를 자주 보내지 말고 묶어서 보내기'],
      ],
      notes: [
        'INSERT 한 번마다 파트가 하나씩 생깁니다. 너무 잘게 자주 넣으면 파트가 머지 속도보다 빨리 쌓여 "Too many parts" 오류가 납니다.',
        '묶어서 보내기 어렵다면 async_insert로 서버 쪽에서 모아 쓰게 할 수 있습니다.',
      ],
    },
    {
      id: 'dist', label: 'Distributed 테이블', sub: 'events_all', x: 350, y: 360, w: 180, kind: 'proxy',
      role: '데이터를 직접 갖지 않는 "창구" 테이블입니다. INSERT는 샤딩 키로 나눠 각 샤드에 보내고, SELECT는 모든 샤드에 나눠 보낸 뒤 결과를 합칩니다. 별도 서버가 아니라 쿼리를 받은 노드(initiator) 위에서 동작합니다.',
      details: [
        ['엔진', 'Distributed(클러스터, DB, 로컬 테이블, 샤딩 키)'],
        ['샤딩 키 예', 'cityHash64(user_id)'],
        ['샤드 내 전송', 'internal_replication=true면 레플리카 1대에만 보냄'],
        ['INSERT 모드', 'distributed_foreground_insert (구 insert_distributed_sync, 셀프호스팅 기본 0=비동기)'],
        ['레플리카 선택', 'load_balancing (기본 random)'],
      ],
      notes: [
        '기본 INSERT는 비동기라, 로컬 디스크 큐에 쌓아 두고 나중에 샤드로 보냅니다. 응답이 성공이어도 아직 샤드에 도착하지 않았을 수 있습니다.',
        '조회 결과의 최종 합치기는 initiator 노드에서 일어납니다. GROUP BY 결과가 크면 initiator 메모리가 먼저 터집니다.',
      ],
    },
    {
      id: 'r11', label: 'replica 1-1', sub: 'shard 1 · ReplicatedMergeTree', x: 690, y: 135, w: 300, h: 126, kind: 'db',
      slots: { cols: 3, empty: '—' },
      role: '샤드 1 데이터의 복제본입니다. 같은 샤드의 레플리카끼리는 같은 데이터를 갖습니다. 데이터는 파트(불변 파일 묶음) 단위로 저장됩니다.',
      details: [
        ['테이블 엔진', 'ReplicatedMergeTree'],
        ['Keeper 경로', '/clickhouse/tables/{shard}/{table}'],
        ['레플리카 이름', '{replica} 매크로'],
        ['파트 확인', 'system.parts'],
        ['복제 큐', 'system.replication_queue'],
      ],
      notes: [
        '레플리카 사이에는 리더·팔로워 구분이 없습니다. 어느 레플리카에 INSERT해도 됩니다(multi-master).',
        'system.replicas의 absolute_delay·queue_size로 복제 지연을 봅니다.',
      ],
    },
    {
      id: 'r12', label: 'replica 1-2', sub: 'shard 1 · ReplicatedMergeTree', x: 690, y: 285, w: 300, h: 126, kind: 'db',
      slots: { cols: 3, empty: '—' },
      role: '샤드 1의 두 번째 복제본입니다. Keeper의 복제 로그를 보고 자기에게 없는 파트를 다른 레플리카에서 직접 받아 옵니다.',
      details: [
        ['파트 전송', '레플리카끼리 직접 (interserver HTTP)'],
        ['받을 목록', 'Keeper의 log → 자기 queue'],
      ],
      notes: [
        '복제는 기본 비동기입니다. INSERT 직후 이 레플리카에서 조회하면 방금 넣은 행이 안 보일 수 있습니다.',
        '모든 레플리카에 쓰여야 성공으로 치려면 insert_quorum을 씁니다(지연 증가).',
      ],
    },
    {
      id: 'r21', label: 'replica 2-1', sub: 'shard 2 · ReplicatedMergeTree', x: 690, y: 475, w: 300, h: 126, kind: 'db',
      slots: { cols: 3, empty: '—' },
      role: '샤드 2 데이터의 복제본입니다. 샤드 1과는 서로 다른 행을 갖습니다(샤딩 키로 나뉨).',
      details: [
        ['데이터 범위', '샤딩 키 해시 % 2 = 1 인 행 (예시)'],
      ],
      notes: [
        '샤드 간 데이터 양이 크게 다르면 샤딩 키가 치우친 것입니다. 느린 샤드가 전체 조회 속도를 정합니다.',
      ],
    },
    {
      id: 'r22', label: 'replica 2-2', sub: 'shard 2 · ReplicatedMergeTree', x: 690, y: 625, w: 300, h: 126, kind: 'db',
      slots: { cols: 3, empty: '—' },
      role: '샤드 2의 두 번째 복제본입니다.',
      details: [
        ['파트 전송', '레플리카끼리 직접 (interserver HTTP)'],
      ],
    },
    {
      id: 'chi', label: 'CHI 매니페스트', sub: 'ClickHouseInstallation', x: 1105, y: 120, w: 210, kind: 'store',
      role: '"샤드 몇 개, 레플리카 몇 개, 어떤 설정·스토리지로"를 선언한 Kubernetes 커스텀 리소스입니다. GitOps라면 git에 있고 ArgoCD가 클러스터에 반영합니다.',
      details: [
        ['리소스', 'ClickHouseInstallation (CHI)'],
        ['Keeper용', 'ClickHouseKeeperInstallation (CHK)'],
        ['주요 항목', 'layout.shardsCount / replicasCount, templates, settings'],
      ],
      notes: [
        '여기 숫자를 바꾸는 것만으로 샤드·레플리카가 늘거나 줄어듭니다. 줄이는 변경은 데이터 이동이 없으므로 특히 조심합니다.',
      ],
    },
    {
      id: 'op', label: 'clickhouse-operator', sub: 'Altinity', x: 1105, y: 270, w: 210, kind: 'ctrl',
      role: 'CHI를 지켜보다가 선언과 실제가 다르면 맞춥니다(reconcile). 호스트마다 StatefulSet·Service와 설정 ConfigMap을 만들고, 새 레플리카에는 테이블 스키마도 복사합니다.',
      details: [
        ['만드는 것', '호스트별 StatefulSet, Service, ConfigMap(remote_servers·macros)'],
        ['스키마 전파', '새 레플리카에 기존 테이블 생성'],
        ['위치', '데이터 경로 밖 (컨트롤 플레인)'],
      ],
      notes: [
        '오퍼레이터가 죽어도 ClickHouse는 계속 동작합니다. 변경 반영만 멈춥니다.',
        '설정 변경이 롤링 재시작을 일으키는지 적용 전에 확인합니다.',
      ],
    },
    {
      id: 'keeper', label: 'ClickHouse Keeper ×3', sub: 'Raft · ZooKeeper 호환', x: 1105, y: 545, w: 220, kind: 'ctrl',
      role: '복제 조정용 메타데이터 저장소입니다. 어떤 파트가 있어야 하는지(복제 로그), 블록 번호, 중복 INSERT 판별용 해시를 보관합니다. 데이터 자체는 이곳을 지나가지 않습니다.',
      details: [
        ['합의', 'Raft, 과반 생존 시 동작 (3대 중 2대)'],
        ['저장 내용', 'replicas, log, block_numbers, blocks(중복 제거 해시)'],
        ['상태 확인', 'system.zookeeper, system.zookeeper_connection'],
      ],
      notes: [
        '과반을 잃으면 Replicated 테이블이 읽기 전용이 되어 INSERT가 실패합니다. SELECT는 됩니다. system.replicas의 is_readonly로 확인합니다.',
        'Keeper가 돌아온 뒤에도 readonly로 남은 테이블은 SYSTEM RESTART REPLICA로 되살립니다.',
        'Keeper 데이터 디스크가 영속 볼륨이 아니면 재시작 때 메타데이터를 잃고 복구가 매우 번거롭습니다.',
      ],
    },
  ],

  edges: [
    { id: 'app-dist', from: 'app', to: 'dist', kind: 'rw', bend: 18 },
    { id: 'dist-app', from: 'dist', to: 'app', kind: 'ro', bend: 18 },
    { id: 'd-r11', from: 'dist', to: 'r11', kind: 'rw' },
    { id: 'd-r21', from: 'dist', to: 'r21', kind: 'rw', bend: 16 },
    { id: 'r11-d', from: 'r11', to: 'dist', kind: 'ro', hidden: true },
    { id: 'r12-d', from: 'r12', to: 'dist', kind: 'ro', hidden: true },
    { id: 'r21-d', from: 'r21', to: 'dist', kind: 'ro', bend: 16, hidden: true },
    { id: 'r11-r12', from: 'r11', to: 'r12', kind: 'repl', bend: -220, label: 'part' },
    { id: 'r21-r22', from: 'r21', to: 'r22', kind: 'repl', bend: -220, label: 'part' },
    { id: 'r11-k', from: 'r11', to: 'keeper', kind: 'ctrl' },
    { id: 'k-r12', from: 'keeper', to: 'r12', kind: 'ctrl' },
    { id: 'r21-k', from: 'r21', to: 'keeper', kind: 'ctrl' },
    { id: 'k-r22', from: 'keeper', to: 'r22', kind: 'ctrl' },
    { id: 'chi-op', from: 'chi', to: 'op', kind: 'ctrl', label: 'watch' },
    { id: 'op-r11', from: 'op', to: 'r11', kind: 'ctrl', hidden: true },
    { id: 'op-r12', from: 'op', to: 'r12', kind: 'ctrl', hidden: true },
    { id: 'op-r21', from: 'op', to: 'r21', kind: 'ctrl', hidden: true },
    { id: 'op-r22', from: 'op', to: 'r22', kind: 'ctrl', hidden: true },
  ],

  steps: [
    {
      title: '전체 구조',
      note: '샤드는 데이터를 나눈 조각이고, 레플리카는 같은 샤드의 복사본입니다.\n2샤드 × 2레플리카 = ClickHouse 서버 4대이고, 데이터는 2벌씩 있습니다.\nKeeper는 레플리카들이 "무엇을 갖고 있어야 하는지"만 맞춰 주고, 오퍼레이터는 이 구성을 Kubernetes 위에 만들어 줍니다.\n노드를 눌러 각 역할을 확인해 보세요.',
      slots: { r11: BASE, r12: BASE, r21: BASE, r22: BASE },
      nodeNotes: {
        keeper: '각 레플리카와 세션을 유지하며 복제 메타데이터를 보관하고 있습니다.',
        dist: '아직 요청이 없습니다. 이 테이블은 모든 노드에 똑같이 만들어 둡니다.',
      },
      flows: [
        { edge: 'r11-k', rate: 0.4, size: 3.5 },
        { edge: 'k-r12', rate: 0.4, size: 3.5 },
        { edge: 'r21-k', rate: 0.4, size: 3.5 },
        { edge: 'k-r22', rate: 0.4, size: 3.5 },
        { edge: 'chi-op', rate: 0.3, size: 3.5 },
      ],
    },
    {
      title: 'INSERT와 샤딩',
      note: '앱이 Distributed 테이블에 2만 행을 넣습니다.\n샤딩 키 해시로 행을 나눠 샤드 1과 샤드 2에 1만 행씩 보냅니다.\n샤드 안에서는 레플리카 1대에만 보내고(internal_replication), 나머지 복사는 복제가 맡습니다.\n받은 레플리카에는 새 파트 all_3_3_0이 하나 생깁니다.',
      slots: { r11: WITH3('load'), r21: WITH3('load') },
      callouts: [{ node: 'dist', text: '샤딩 키로 분배', tone: 'info', below: true }],
      nodeNotes: {
        dist: '행마다 샤딩 키 해시를 계산해 샤드를 고르고, 샤드마다 레플리카 1대로 보냅니다.',
        r11: 'INSERT 블록이 새 파트 all_3_3_0이 됩니다. 블록 번호 3은 Keeper에서 받아 옵니다.',
        r21: '샤드 2 몫의 1만 행이 새 파트가 됩니다.',
        app: 'INSERT 한 번 = 샤드마다 파트 하나. 그래서 묶어서 넣어야 합니다.',
      },
      flows: [
        { edge: 'app-dist', rate: 1.6 },
        { edge: 'd-r11', rate: 1.2 },
        { edge: 'd-r21', rate: 1.2 },
      ],
    },
    {
      title: '레플리카 간 복제',
      note: '파트를 만든 레플리카가 Keeper의 복제 로그에 "all_3_3_0 생김"을 기록합니다.\n다른 레플리카는 로그를 보고 자기 큐에 넣은 뒤, 파트를 원본 레플리카에서 직접 받아 옵니다.\nKeeper는 목록만 나르고, 실제 데이터는 레플리카끼리 주고받습니다.',
      slots: {
        r11: WITH3(null), r21: WITH3(null),
        r12: WITH3('load'), r22: WITH3('load'),
      },
      callouts: [{ node: 'keeper', text: 'log: all_3_3_0', tone: 'info', below: true }],
      nodeNotes: {
        keeper: '복제 로그에 새 파트 항목이 추가되었습니다. 중복 INSERT 판별용 블록 해시도 저장합니다.',
        r11: '로그에 기록한 뒤, replica 1-2의 요청에 파트를 보내 줍니다.',
        r12: '로그를 보고 all_3_3_0을 replica 1-1에서 받아 옵니다.',
        r22: '같은 방식으로 replica 2-1에서 받아 옵니다.',
      },
      flows: [
        { edge: 'r11-k', rate: 1, size: 4 },
        { edge: 'k-r12', rate: 1, size: 4 },
        { edge: 'r21-k', rate: 1, size: 4 },
        { edge: 'k-r22', rate: 1, size: 4 },
        { edge: 'r11-r12', rate: 1.6 },
        { edge: 'r21-r22', rate: 1.6 },
      ],
    },
    {
      title: '백그라운드 머지',
      note: '작은 파트가 쌓이면 백그라운드에서 하나로 합칩니다(머지).\nall_1_1_0 + all_2_2_0 + all_3_3_0 → all_1_3_1 (블록 1~3, 머지 레벨 1).\n머지 계획도 복제 로그에 올라가서 모든 레플리카가 같은 결과 파트를 갖게 됩니다.\n합쳐진 원래 파트는 잠시 뒤 지워집니다.',
      slots: {
        r11: MERGED('write'), r12: MERGED('write'),
        r21: WITH3(null), r22: WITH3(null),
      },
      callouts: [{ node: 'r11', text: '3개 파트 → 1개', tone: 'ok' }],
      nodeNotes: {
        r11: '머지를 계획해 로그에 올리고, 자기 파트 3개를 all_1_3_1로 합칩니다.',
        r12: '로그의 머지 항목을 보고 같은 머지를 직접 수행합니다(필요하면 결과 파트를 받아 오기도 함).',
        keeper: '머지 항목(MERGE_PARTS)이 복제 로그에 기록됩니다.',
        app: '머지가 INSERT 속도를 못 따라가면 파트가 계속 늘어 결국 INSERT가 거부됩니다.',
      },
      flows: [
        { edge: 'r11-k', rate: 0.8, size: 4 },
        { edge: 'k-r12', rate: 0.8, size: 4 },
      ],
    },
    {
      title: '분산 조회 (SELECT)',
      note: 'Distributed 테이블에 SELECT를 보내면 샤드마다 레플리카 1대를 골라 쿼리를 나눠 보냅니다.\n각 샤드가 자기 몫을 계산해 중간 결과를 돌려주고, initiator가 최종으로 합쳐 앱에 돌려줍니다.\n레플리카 선택은 load_balancing 설정을 따릅니다. 이번에는 샤드 1에서 replica 1-2가 골라졌습니다.',
      edges: { 'd-r11': 'dim', 'd-r21': 'dim', 'r12-d': 'on', 'r21-d': 'on' },
      slots: { r11: MERGED(null), r12: MERGED(null) },
      callouts: [{ node: 'dist', text: 'initiator에서 최종 합치기', tone: 'info', below: true }],
      nodeNotes: {
        dist: '샤드별 중간 결과를 받아 최종 GROUP BY·ORDER BY를 마칩니다. 메모리가 가장 많이 드는 곳입니다.',
        r12: '샤드 1 몫을 계산해 중간 결과를 보냅니다.',
        r21: '샤드 2 몫을 계산해 중간 결과를 보냅니다.',
        r11: '이번 조회에서는 쉬고 있습니다. 같은 데이터를 가졌으니 언제든 대신할 수 있습니다.',
      },
      flows: [
        { edge: 'r12-d', rate: 1.4 },
        { edge: 'r21-d', rate: 1.4 },
        { edge: 'dist-app', rate: 1.4 },
      ],
    },
    {
      title: '레플리카 장애',
      note: 'replica 1-2가 죽어도 샤드 1에는 replica 1-1이 남아 있습니다.\n조회는 살아 있는 레플리카로 가고, INSERT도 계속됩니다.\n복구되면 Keeper의 복제 로그에서 빠진 항목을 찾아 파트를 받아 오며 자동으로 따라잡습니다.',
      states: { r12: 'down' },
      edges: { 'r12-d': 'off', 'r11-d': 'on', 'r11-r12': 'dim', 'k-r12': 'dim' },
      callouts: [{ node: 'r12', text: '복구 후 로그로 따라잡기', tone: 'warn', below: true }],
      nodeNotes: {
        r12: '응답하지 않습니다. 돌아오면 Keeper 로그와 비교해 빠진 파트를 받아 옵니다.',
        r11: '샤드 1의 조회를 혼자 받습니다.',
        keeper: 'replica 1-2가 받아야 할 항목을 계속 보관해 둡니다.',
      },
      flows: [
        { edge: 'app-dist', rate: 1.2 },
        { edge: 'd-r11', rate: 1 },
        { edge: 'r11-d', rate: 1.4 },
        { edge: 'r21-d', rate: 1.4 },
        { edge: 'dist-app', rate: 1.4 },
        { edge: 'k-r12', rate: 0.8, size: 3.5, fail: true },
      ],
    },
    {
      title: 'Keeper 과반 상실',
      note: 'Keeper가 과반을 잃으면 레플리카들이 복제 메타데이터를 쓸 수 없습니다.\n그래서 Replicated 테이블이 읽기 전용이 되어 INSERT가 실패합니다.\n이미 있는 데이터의 SELECT는 그대로 됩니다.\n3대 중 1대가 죽는 것은 괜찮고, 2대가 죽으면 이 상태가 됩니다.',
      states: { r12: 'normal', keeper: 'down' },
      edges: { 'r11-r12': 'on', 'k-r12': 'on', 'r11-d': 'off', 'r12-d': 'on', 'd-r11': 'on', 'd-r21': 'on' },
      callouts: [
        { node: 'keeper', text: '과반 상실', tone: 'warn' },
        { node: 'dist', text: 'INSERT 실패 · SELECT 가능', tone: 'warn', below: true },
      ],
      nodeNotes: {
        keeper: '살아 있는 노드가 과반이 안 되어 쓰기를 받을 수 없습니다.',
        r11: '테이블이 readonly 상태가 되어 INSERT를 거절합니다.',
        dist: 'INSERT는 실패하고, SELECT는 샤드에서 정상으로 돌아옵니다.',
        app: '"Table is in readonly mode" 계열 오류를 받습니다.',
      },
      flows: [
        { edge: 'app-dist', rate: 1.2 },
        { edge: 'd-r11', rate: 1, fail: true },
        { edge: 'd-r21', rate: 1, fail: true },
        { edge: 'r12-d', rate: 1.2 },
        { edge: 'r21-d', rate: 1.2 },
        { edge: 'dist-app', rate: 1.2 },
        { edge: 'r11-k', rate: 0.6, size: 3.5, fail: true },
        { edge: 'r21-k', rate: 0.6, size: 3.5, fail: true },
      ],
    },
    {
      title: '오퍼레이터 reconcile',
      note: 'CHI 매니페스트를 바꾸면(예: 설정 변경, 레플리카 추가) 오퍼레이터가 차이를 찾아 맞춥니다.\n호스트별 StatefulSet·Service와 remote_servers·매크로 설정을 갱신하고, 새 레플리카에는 테이블 스키마를 만듭니다.\n오퍼레이터는 데이터 경로에 없습니다. 멈춰도 조회·INSERT는 계속되고 변경 반영만 멈춥니다.',
      states: { keeper: 'normal' },
      edges: { 'op-r11': 'on', 'op-r12': 'on', 'op-r21': 'on', 'op-r22': 'on', 'r12-d': 'off', 'r21-d': 'off' },
      callouts: [{ node: 'op', text: '선언 ↔ 실제 비교', tone: 'ok', below: true }],
      nodeNotes: {
        chi: '변경된 매니페스트가 반영되었습니다(GitOps라면 git → ArgoCD → CHI).',
        op: '선언과 실제 차이를 계산해 StatefulSet·ConfigMap을 갱신합니다. 설정에 따라 롤링 재시작이 일어날 수 있습니다.',
        r11: '갱신된 설정을 받습니다. 재시작이 필요하면 한 대씩 진행됩니다.',
      },
      flows: [
        { edge: 'chi-op', rate: 1, size: 4 },
        { edge: 'op-r11', rate: 0.8, size: 4 },
        { edge: 'op-r12', rate: 0.8, size: 4 },
        { edge: 'op-r21', rate: 0.8, size: 4 },
        { edge: 'op-r22', rate: 0.8, size: 4 },
        { edge: 'app-dist', rate: 1 },
        { edge: 'd-r11', rate: 0.8 },
        { edge: 'd-r21', rate: 0.8 },
      ],
    },
  ],
});
