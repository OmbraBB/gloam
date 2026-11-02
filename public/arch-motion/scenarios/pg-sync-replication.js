// PostgreSQL 동기/비동기 복제 — synchronous_commit 단계별로 COMMIT 응답이 어디서 기다리는지
// 근거: PostgreSQL 공식 문서(High Availability: Synchronous Replication, synchronous_commit, synchronous_standby_names)
// 슬롯 초록 테두리 = COMMIT 응답이 기다리는 마지막 지점
const st = (p, sub, hl) => ({ p, sub, hl });
const PRI = (hl) => [st('WAL 기록', 'WAL 버퍼'), st('로컬 flush', 'Primary 디스크', hl), st('응답', 'COMMIT OK')];
const STB = (w, f, a) => [st('write', 'OS 버퍼', w), st('flush', '디스크 fsync', f), st('apply', '재생 → 조회 가능', a)];

ArchMotion.scenario({
  title: 'PostgreSQL 동기·비동기 복제',
  summary: 'synchronous_commit 값에 따라 COMMIT 응답이 Primary·Standby의 어느 단계까지 기다리는지, 그 대가로 지연과 유실 범위(RPO)가 어떻게 바뀌는지 보여줍니다.',
  disclaimer: '커뮤니티 PostgreSQL 기준 · Standby 2대 예시',
  width: 1160,
  height: 580,

  kindNames: { rw: 'COMMIT 요청', ro: 'COMMIT 응답', repl: 'WAL 전송', ctrl: 'Standby 확인(ack)' },

  groups: [
    { label: '클라이언트', x: 20, y: 60, w: 190, h: 480, tone: 'app' },
    { label: 'Primary', x: 250, y: 60, w: 380, h: 480, tone: 'db' },
    { label: 'Standby', x: 680, y: 40, w: 460, h: 520, tone: 'db' },
  ],

  nodes: [
    {
      id: 'app', label: '애플리케이션', sub: 'COMMIT 호출', x: 115, y: 300, kind: 'app',
      role: 'COMMIT을 보내고 응답을 기다립니다. 응답을 받은 순간을 "저장됐다"고 믿습니다.',
      details: [['트랜잭션별 조절', "SET LOCAL synchronous_commit = 'local' 등"]],
      notes: ['중요도가 낮은 쓰기(로그·통계)는 트랜잭션 단위로 synchronous_commit을 낮춰 지연을 줄일 수 있습니다.'],
    },
    {
      id: 'pri', label: 'Primary', sub: 'synchronous_commit', x: 440, y: 300, w: 330, h: 130, kind: 'db',
      slots: { cols: 3, w: 96, h: 50 },
      role: 'COMMIT의 WAL을 로컬 디스크에 flush하고, 설정에 따라 동기 Standby의 확인(ack)까지 기다린 뒤 응답합니다.',
      details: [
        ['synchronous_commit', 'off · local · remote_write · on(기본) · remote_apply'],
        ['동기 대상', "synchronous_standby_names (비어 있으면 모두 비동기)"],
        ['상태 확인', 'pg_stat_replication: sync_state, write_lag, flush_lag, replay_lag'],
      ],
      notes: [
        'synchronous_standby_names가 비어 있으면 on·remote_write·remote_apply도 local처럼 동작합니다. 기본 설정이 "비동기 복제"인 이유입니다.',
        'off는 로컬 flush도 기다리지 않습니다. 크래시 때 최근 커밋 몇 개가 사라질 수 있지만 데이터가 깨지지는 않습니다.',
      ],
    },
    {
      id: 's1', label: 'Standby 1', sub: 'walreceiver', x: 910, y: 160, w: 330, h: 130, kind: 'db',
      slots: { cols: 3, w: 96, h: 50 },
      role: 'Primary의 WAL을 받아 OS에 쓰고(write), 디스크에 flush하고, 재생(apply)해서 조회에 반영합니다. 각 단계 위치를 Primary에 알려 줍니다.',
      details: [
        ['단계', 'write → flush → apply(replay)'],
        ['Standby 쪽 확인', 'pg_stat_wal_receiver, pg_last_wal_replay_lsn()'],
      ],
    },
    {
      id: 's2', label: 'Standby 2', sub: 'walreceiver', x: 910, y: 440, w: 330, h: 130, kind: 'db',
      slots: { cols: 3, w: 96, h: 50 },
      role: '두 번째 Standby입니다. 동기 대상 목록에 들어 있지 않으면 비동기로만 따라옵니다.',
      details: [['역할', '설정에 따라 비동기 또는 쿼럼 후보']],
    },
  ],

  edges: [
    { id: 'app-pri', from: 'app', to: 'pri', kind: 'rw', bend: 16 },
    { id: 'pri-app', from: 'pri', to: 'app', kind: 'ro', bend: 16 },
    { id: 'pri-s1', from: 'pri', to: 's1', kind: 'repl', bend: 14 },
    { id: 's1-pri', from: 's1', to: 'pri', kind: 'ctrl', bend: 14 },
    { id: 'pri-s2', from: 'pri', to: 's2', kind: 'repl', bend: -14 },
    { id: 's2-pri', from: 's2', to: 'pri', kind: 'ctrl', bend: -14 },
  ],

  steps: [
    {
      title: '비동기 (기본)',
      note: "synchronous_standby_names = '' (비어 있음)\nCOMMIT은 Primary 로컬 디스크에 WAL을 flush하면 바로 응답합니다.\nWAL은 그 뒤에 Standby로 흘러갑니다.\n가장 빠르지만, 응답 직후 Primary가 죽고 페일오버하면 아직 전송 안 된 커밋이 사라집니다(RPO > 0).",
      slots: { pri: PRI('hit'), s1: STB(), s2: STB() },
      callouts: [{ node: 'app', text: '대기: 로컬 flush까지', tone: 'ok', below: true }],
      nodeNotes: {
        pri: '로컬 flush 후 즉시 응답합니다. Standby는 기다리지 않습니다.',
        s1: '조금 늦게 따라옵니다. 그 차이가 replay_lag입니다.',
      },
      flows: [
        { edge: 'app-pri', rate: 1.4 },
        { edge: 'pri-app', rate: 1.4 },
        { edge: 'pri-s1', rate: 1.4 },
        { edge: 'pri-s2', rate: 1.4 },
      ],
    },
    {
      title: 'remote_write',
      note: "synchronous_standby_names = 'FIRST 1 (s1)'  ·  synchronous_commit = remote_write\nStandby 1이 WAL을 받아 OS에 썼다(write)는 확인까지 기다립니다.\nPrimary만 죽는 경우에는 안전하지만, Standby OS까지 함께 죽으면 fsync 전 데이터가 사라질 수 있습니다.",
      slots: { s1: STB('hit') },
      callouts: [{ node: 'app', text: '대기: Standby write까지', tone: 'ok', below: true }],
      nodeNotes: {
        s1: 'OS 버퍼에 쓴 시점에 ack를 보냅니다.',
        pri: '로컬 flush + Standby 1의 write ack를 받고 응답합니다.',
        s2: '목록에 없으므로 비동기입니다.',
      },
      flows: [
        { edge: 'app-pri', rate: 1.2 },
        { edge: 'pri-s1', rate: 1.2 },
        { edge: 's1-pri', rate: 1.2, size: 4 },
        { edge: 'pri-app', rate: 1.2 },
        { edge: 'pri-s2', rate: 1.2 },
      ],
    },
    {
      title: 'on (동기 복제 기본)',
      note: "synchronous_commit = on\nStandby 1이 WAL을 디스크에 flush했다는 확인까지 기다립니다.\n서버 한 대가 어떻게 죽어도 커밋된 데이터는 다른 한 대의 디스크에 있습니다(단일 장애 RPO 0).\n대가로 매 커밋에 네트워크 왕복 + Standby fsync 시간이 더해집니다.",
      slots: { s1: STB(null, 'hit') },
      callouts: [{ node: 'app', text: '대기: Standby flush까지', tone: 'ok', below: true }],
      nodeNotes: {
        s1: '디스크 fsync 후 ack를 보냅니다.',
        pri: 'flush ack를 받을 때까지 COMMIT 응답을 붙잡습니다.',
      },
      flows: [
        { edge: 'app-pri', rate: 1 },
        { edge: 'pri-s1', rate: 1 },
        { edge: 's1-pri', rate: 1, size: 4 },
        { edge: 'pri-app', rate: 1 },
        { edge: 'pri-s2', rate: 1 },
      ],
    },
    {
      title: 'remote_apply',
      note: "synchronous_commit = remote_apply\nStandby 1이 WAL을 재생해 조회에 보이게 된 시점까지 기다립니다.\n커밋 직후 Standby에서 읽어도 방금 쓴 값이 보장됩니다(read-your-writes).\n지연이 가장 크고, Standby의 긴 쿼리가 재생을 막으면 커밋도 같이 느려집니다.",
      slots: { s1: STB(null, null, 'hit') },
      callouts: [{ node: 'app', text: '대기: Standby apply까지', tone: 'warn', below: true }],
      nodeNotes: {
        s1: '재생까지 끝낸 뒤 ack를 보냅니다. 재생이 밀리면 Primary 커밋이 그만큼 기다립니다.',
        pri: '가장 오래 기다리는 설정입니다.',
      },
      flows: [
        { edge: 'app-pri', rate: 0.8 },
        { edge: 'pri-s1', rate: 0.8 },
        { edge: 's1-pri', rate: 0.8, size: 4 },
        { edge: 'pri-app', rate: 0.8 },
        { edge: 'pri-s2', rate: 0.8 },
      ],
    },
    {
      title: '동기 Standby 장애',
      note: "synchronous_standby_names = 'FIRST 1 (s1)' 상태에서 Standby 1이 죽었습니다.\nPrimary는 s1의 ack를 끝없이 기다리고, 모든 쓰기 COMMIT이 멈춥니다(장애처럼 보임).\n대기 중 취소하면 로컬에는 이미 커밋된 상태라 경고와 함께 남습니다.\n대응: 동기 대상을 둘 이상 두는 쿼럼 구성, 또는 synchronous_standby_names를 비우고 reload(일시적으로 비동기 전환).",
      states: { s1: 'down' },
      slots: { s1: STB(), pri: PRI(null) },
      callouts: [
        { node: 'pri', text: 'COMMIT 무기한 대기', tone: 'warn', below: true },
        { node: 's1', text: '응답 없음', tone: 'warn' },
      ],
      nodeNotes: {
        pri: 'pg_stat_activity의 wait_event가 SyncRep인 세션이 쌓입니다.',
        app: '쓰기 요청이 타임아웃 날 때까지 응답을 못 받습니다.',
        s2: '비동기로는 계속 받고 있지만 동기 대상이 아니라 도움이 안 됩니다.',
      },
      flows: [
        { edge: 'app-pri', rate: 1.2 },
        { edge: 'pri-s1', rate: 1, fail: true },
        { edge: 'pri-s2', rate: 1 },
      ],
    },
    {
      title: '쿼럼 동기 (ANY 1)',
      note: "synchronous_standby_names = 'ANY 1 (s1, s2)'\n목록 중 아무나 1대만 ack하면 COMMIT 응답을 보냅니다.\nStandby 1이 죽어도 Standby 2의 ack로 쓰기가 계속됩니다.\n동기 복제를 쓸 때는 Standby를 최소 2대 두고 쿼럼으로 묶어야 한 대 장애가 전체 쓰기 장애가 되지 않습니다.",
      slots: { pri: PRI('hit'), s2: STB(null, 'hit') },
      callouts: [{ node: 's2', text: '대신 ack', tone: 'ok', below: true }],
      nodeNotes: {
        pri: 's2의 flush ack로 COMMIT을 완료합니다. sync_state가 quorum으로 표시됩니다.',
        s2: '쿼럼 후보로서 ack를 보냅니다.',
        s1: '복구되면 다시 쿼럼 후보가 됩니다.',
      },
      flows: [
        { edge: 'app-pri', rate: 1 },
        { edge: 'pri-s2', rate: 1 },
        { edge: 's2-pri', rate: 1, size: 4 },
        { edge: 'pri-app', rate: 1 },
      ],
    },
  ],
});
