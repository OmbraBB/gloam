/*
 * Arch Motion 엔진 — 의존성 없는 SVG 아키텍처 애니메이션
 *
 * 시나리오(노드·연결선·단계)를 데이터로 받아 그린다.
 * - 노드 상태·라벨·연결선 표시 여부는 단계를 따라 누적 적용된다(어느 단계로 바로 이동해도 같은 결과).
 * - 흐름(flows)·말풍선(callouts)·노드별 단계 설명(nodeNotes)은 해당 단계에만 적용된다.
 * - 노드를 누르면 역할·세부 구성·운영 포인트·연결 관계를 보여주는 상세 카드가 열린다.
 */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const NODE_W = 168;
  const NODE_H = 64;
  const SPEED = 0.16;     // 패킷 이동 속도(px/ms)
  const FAIL_AT = 0.55;   // 실패 흐름의 패킷이 사라지는 지점(경로 비율)
  const DEFAULT_HOLD = 7000;

  const KINDS = {
    rw: '쓰기',
    ro: '읽기',
    repl: '복제(WAL)',
    ctrl: '헬스체크·제어',
    fail: '실패',
  };

  // 노드 종류별 이름과 16×16 아이콘(선 그리기)
  const NODE_KINDS = {
    app: { name: '애플리케이션', icon: 'M2 3.5h12v9H2z M2 6.5h12 M4 5h.01 M6 5h.01' },
    proxy: { name: '커넥션 프록시', icon: 'M2 5h9 M8.5 2.5L11 5 8.5 7.5 M14 11H5 M7.5 8.5L5 11l2.5 2.5' },
    lb: { name: '로드밸런서', icon: 'M8 2v4 M8 6L3 13 M8 6l5 7 M8 6v7' },
    db: { name: '데이터베이스', icon: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4 M3 8c0 1.1 2.2 2 5 2s5-.9 5-2' },
    ctrl: { name: '제어·감시', icon: 'M1 8h3l2-4.5 3 9 2-4.5h4' },
    fw: { name: '방화벽', icon: 'M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z' },
    queue: { name: '큐·스트림', icon: 'M2 4h12 M2 8h12 M2 12h12 M11 2l3 2-3 2' },
    store: { name: '저장소', icon: 'M2 4h12v8H2z M2 7h12 M5 9.5h3' },
    proc: { name: '프로세스', icon: 'M8 2v2 M8 12v2 M2 8h2 M12 8h2 M4.5 4.5l1.4 1.4 M10.1 10.1l1.4 1.4 M4.5 11.5l1.4-1.4 M10.1 5.9l1.4-1.4 M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5z' },
    mem: { name: '메모리 구조', icon: 'M3 4h10v8H3z M5 4V2 M8 4V2 M11 4V2 M5 14v-2 M8 14v-2 M11 14v-2 M6 7h4v2H6z' },
    disk: { name: '디스크 파일', icon: 'M4 1.5h5.5L12 4v10.5H4z M9.5 1.5V4H12 M6 8h4 M6 10.5h4' },
  };

  // 버퍼 슬롯 그리드 위젯 크기
  const SLOT_W = 80;
  const SLOT_H = 48;
  const SLOT_GAP_X = 12;
  const SLOT_GAP_Y = 18;
  const SLOT_TOP = 56;

  const STATES = {
    normal: '정상',
    down: '장애',
    promoted: '승격됨',
    busy: '부하 집중',
    recovering: '복구 중',
  };

  let registered = null;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 텍스트 뒤에 배경 사각형을 깐다(선 위 라벨·영역 탭 가독성용)
  function backplate(text, rect, padX, padY) {
    const bb = text.getBBox();
    rect.setAttribute('x', bb.x - padX);
    rect.setAttribute('y', bb.y - padY);
    rect.setAttribute('width', bb.width + padX * 2);
    rect.setAttribute('height', bb.height + padY * 2);
  }

  // 노드 중심에서 (tx, ty) 방향으로 그은 선이 노드 사각형 경계와 만나는 점
  function borderPoint(n, tx, ty) {
    const dx = tx - n.x;
    const dy = ty - n.y;
    if (dx === 0 && dy === 0) return { x: n.x, y: n.y };
    const s = Math.min(n.w / 2 / Math.abs(dx || 1e-9), n.h / 2 / Math.abs(dy || 1e-9));
    return { x: n.x + dx * s, y: n.y + dy * s };
  }

  // 노드 한 면의 가운데 점 (fromSide/toSide로 연결선이 나가고 들어올 면을 고정할 때)
  function sidePoint(n, side) {
    if (side === 'left') return { x: n.x - n.w / 2, y: n.y };
    if (side === 'right') return { x: n.x + n.w / 2, y: n.y };
    if (side === 'top') return { x: n.x, y: n.y - n.h / 2 };
    if (side === 'bottom') return { x: n.x, y: n.y + n.h / 2 };
    return null;
  }

  // bend 값만큼 휘어진 2차 곡선 경로와 라벨 위치
  function edgeGeometry(e, a, b) {
    const sa = sidePoint(a, e.fromSide);
    const sb = sidePoint(b, e.toSide);
    const ax = sa ? sa.x : a.x;
    const ay = sa ? sa.y : a.y;
    const bx = sb ? sb.x : b.x;
    const by = sb ? sb.y : b.y;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const bend = e.bend || 0;
    const cx = (ax + bx) / 2 - (dy / len) * bend;
    const cy = (ay + by) / 2 + (dx / len) * bend;
    const p1 = sa || borderPoint(a, cx, cy);
    const p2 = sb || borderPoint(b, cx, cy);
    return {
      d: `M${p1.x},${p1.y} Q${cx},${cy} ${p2.x},${p2.y}`,
      mid: { x: 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x, y: 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y },
    };
  }

  // 0..i 단계의 states/labels/edges/slots/hand를 차례로 덮어써서 i 단계 시점의 상태를 만든다
  function resolve(sc, i) {
    const r = { states: {}, labels: {}, subs: {}, edges: {}, slots: {}, hand: {} };
    for (let k = 0; k <= i; k++) {
      const st = sc.steps[k];
      Object.assign(r.states, st.states);
      Object.assign(r.labels, st.labels);
      Object.assign(r.subs, st.subs);
      Object.assign(r.edges, st.edges);
      Object.assign(r.slots, st.slots);
      Object.assign(r.hand, st.hand);
    }
    return r;
  }

  // 슬롯 크기는 노드별로 slots.w / slots.h로 바꿀 수 있다
  function slotSize(node) {
    return { w: node.slots.w || SLOT_W, h: node.slots.h || SLOT_H };
  }

  function slotPos(node, i) {
    const { w: SW, h: SH } = slotSize(node);
    const cols = node.slots.cols;
    const totalW = cols * SW + (cols - 1) * SLOT_GAP_X;
    return {
      x: node.x - totalW / 2 + (i % cols) * (SW + SLOT_GAP_X),
      y: node.y - node.h / 2 + SLOT_TOP + Math.floor(i / cols) * (SH + SLOT_GAP_Y),
    };
  }

  // 슬롯 값이 [이전, 이후] 배열이면 클럭 바늘이 지나간 뒤 이후 값을 쓴다
  function phase(v, passed) {
    return Array.isArray(v) ? v[passed ? 1 : 0] : v;
  }

  function renderSlots(run, node, passed, handAt) {
    const list = run.resolved.slots[node.id] || [];
    const { w: SLOT_W, h: SLOT_H } = slotSize(node);
    node.slotLayer.innerHTML = '';
    list.forEach((s, i) => {
      const p = slotPos(node, i);
      const on = passed.has(i);
      const hl = phase(s.hl, on);
      const dirty = phase(s.dirty, on);
      const uc = phase(s.uc, on) || 0;
      const cls = ['slot'];
      if (!s.p) cls.push('is-empty');
      if (dirty) cls.push('is-dirty');
      if (hl) cls.push(`hl-${hl}`);
      const g = el('g', { class: cls.join(' ') }, node.slotLayer);
      el('rect', { class: 'slot-box', x: p.x, y: p.y, width: SLOT_W, height: SLOT_H, rx: 6 }, g);
      el('text', { class: 'slot-tag', x: p.x + SLOT_W / 2, y: p.y + 22 }, g).textContent = s.p || node.slots.empty || '빈 슬롯';
      if (!s.p) return;
      // usage_count가 없는 슬롯(예: MergeTree 파트)은 점 대신 보조 문구를 보여준다
      if (s.uc == null) {
        if (s.sub) el('text', { class: 'slot-sub', x: p.x + SLOT_W / 2, y: p.y + 37 }, g).textContent = s.sub;
      } else for (let k = 0; k < 5; k++) {
        el('circle', { class: `uc-dot${k < uc ? ' on' : ''}`, cx: p.x + SLOT_W / 2 - 18 + k * 9, cy: p.y + 36, r: 2.6 }, g);
      }
      if (dirty) el('text', { class: 'slot-dirty', x: p.x + SLOT_W - 7, y: p.y + 11 }, g).textContent = 'D';
      if (phase(s.pin, on)) el('text', { class: 'slot-pin', x: p.x + 6, y: p.y + 11 }, g).textContent = 'PIN';
    });

    if (handAt == null || handAt < 0 || handAt >= list.length) {
      // 숨긴 바늘이 원점에 남으면 노드의 경계 상자가 (0,0)까지 늘어나므로 렌더링에서 뺀다
      node.handEl.style.display = 'none';
      return;
    }
    const p = slotPos(node, handAt);
    node.handEl.style.display = '';
    node.handEl.style.transform = `translate(${p.x + SLOT_W / 2}px, ${p.y - 3}px)`;
  }

  // 단계의 sweep 정의대로 클럭 바늘을 칸 단위로 옮긴다. 끝까지 가면 잠시 멈췄다가 다시 처음부터 보여준다
  function tickSweep(run, force) {
    const st = run.sc.steps[run.index];
    for (const id in run.nodes) {
      const node = run.nodes[id];
      if (!node.slots) continue;
      const sw = st.sweep && st.sweep.node === id ? st.sweep : null;
      let k = -1;
      if (sw) {
        const every = sw.every || 900;
        const t = (run.clock - run.stepStart) % ((sw.path.length + 3) * every);
        k = Math.min(Math.floor(t / every), sw.path.length - 1);
      }
      if (!force && k === node.sweepK) continue;
      node.sweepK = k;
      const passed = new Set(sw ? sw.path.slice(0, k + 1) : []);
      renderSlots(run, node, passed, sw ? sw.path[k] : run.resolved.hand[id]);
    }
  }

  function mount(sc, refs) {
    const svg = refs.stage;
    const W = sc.width || 1000;
    const H = sc.height || 560;
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const defs = el('defs', {}, svg);
    const grid = el('pattern', { id: 'am-grid', width: 20, height: 20, patternUnits: 'userSpaceOnUse' }, defs);
    el('circle', { class: 'grid-dot', cx: 1, cy: 1, r: 1 }, grid);
    for (const kind of Object.keys(KINDS)) {
      const m = el('marker', {
        id: `arrow-${kind}`, class: `arrow arrow-${kind}`, viewBox: '0 0 10 10',
        refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
      }, defs);
      el('path', { d: 'M0,0 L10,5 L0,10 z' }, m);
    }
    el('rect', { class: 'grid-bg', x: 0, y: 0, width: W, height: H, fill: 'url(#am-grid)' }, svg);

    const layers = {};
    for (const name of ['groups', 'edges', 'packets', 'nodes', 'callouts']) {
      layers[name] = el('g', { class: `layer-${name}` }, svg);
    }

    for (const gr of sc.groups || []) {
      const g = el('g', { class: `group tone-${gr.tone || 'none'}` }, layers.groups);
      el('rect', { class: 'group-box', x: gr.x, y: gr.y, width: gr.w, height: gr.h, rx: 12 }, g);
      const plate = el('rect', { class: 'group-tab', rx: 5 }, g);
      const text = el('text', { class: 'group-label', x: gr.x + 16, y: gr.y + 4 }, g);
      text.textContent = gr.label;
      backplate(text, plate, 7, 3);
    }

    const nodes = {};
    for (const n of sc.nodes) {
      const node = Object.assign({ w: NODE_W, h: NODE_H }, n);
      const kind = NODE_KINDS[n.kind] ? n.kind : 'app';
      const x0 = node.x - node.w / 2;
      const y0 = node.y - node.h / 2;
      const g = el('g', { class: `node kind-${kind}`, tabindex: 0, role: 'button', 'data-id': n.id }, layers.nodes);
      el('rect', { class: 'node-halo', x: x0 - 5, y: y0 - 5, width: node.w + 10, height: node.h + 10, rx: 14 }, g);
      el('rect', { class: 'node-box', x: x0, y: y0, width: node.w, height: node.h, rx: 10 }, g);
      el('path', { class: 'node-icon', d: NODE_KINDS[kind].icon, transform: `translate(${x0 + 9},${y0 + 8}) scale(0.75)` }, g);
      // 슬롯 그리드가 있는 노드는 라벨을 위쪽에 둔다
      const ly = node.slots ? y0 + 22 : node.y + 1;
      node.labelEl = el('text', { class: 'node-label', x: node.x, y: ly }, g);
      node.subEl = el('text', { class: 'node-sub', x: node.x, y: ly + 16 }, g);
      if (node.slots) {
        node.slotLayer = el('g', { class: 'slots' }, g);
        node.handEl = el('g', { class: 'hand' }, g);
        el('path', { d: 'M-6,-8 L6,-8 L0,0 z' }, node.handEl);
      }
      node.kind = kind;
      node.g = g;
      nodes[n.id] = node;
    }

    const edges = {};
    for (const e of sc.edges) {
      const geo = edgeGeometry(e, nodes[e.from], nodes[e.to]);
      const kind = e.kind || 'rw';
      const g = el('g', { class: `edge kind-${kind}` }, layers.edges);
      const path = el('path', { class: 'edge-line', d: geo.d, 'marker-end': `url(#arrow-${kind})` }, g);
      if (e.label) {
        const plate = el('rect', { class: 'edge-plate', rx: 4 }, g);
        const text = el('text', { class: 'edge-label', x: geo.mid.x, y: geo.mid.y + 4 }, g);
        text.textContent = e.label;
        backplate(text, plate, 5, 2);
      }
      edges[e.id] = Object.assign({}, e, { kind, g, path, len: path.getTotalLength() });
    }

    // 시나리오가 흐름 종류 이름을 바꿀 수 있다(예: repl → 'WAL 기록')
    const kinds = Object.assign({}, KINDS, sc.kindNames);
    renderLegend(refs.legend, sc, kinds);

    const run = {
      sc, refs, nodes, edges, layers, kinds,
      index: 0, clock: 0, stepStart: 0,
      paused: false, auto: false, focus: null,
      flows: [], packets: [], bursts: [],
    };

    renderStepList(run);
    bindControls(run);
    bindSelection(run);
    go(run, 0);

    let last = performance.now();
    function frame(now) {
      const dt = Math.min(now - last, 100);
      last = now;
      if (!run.paused) {
        run.clock += dt;
        update(run, dt);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return run;
  }

  function go(run, i) {
    const { sc, nodes, edges, layers, refs } = run;
    const n = sc.steps.length;
    run.index = ((i % n) + n) % n;
    run.stepStart = run.clock;
    const st = sc.steps[run.index];
    const r = resolve(sc, run.index);
    run.resolved = r;

    for (const id in nodes) {
      const node = nodes[id];
      node.state = r.states[id] || 'normal';
      node.g.classList.remove(...Object.keys(STATES).map((s) => `is-${s}`));
      node.g.classList.add(`is-${node.state}`);
      node.labelEl.textContent = r.labels[id] ?? node.label;
      node.subEl.textContent = r.subs[id] ?? node.sub ?? '';
      node.g.setAttribute('aria-label', `${node.labelEl.textContent} 상세 보기`);
    }

    for (const id in edges) {
      const e = edges[id];
      const mode = r.edges[id] || (e.hidden ? 'off' : 'on');
      e.mode = mode;
      e.visible = mode !== 'off';
      e.g.classList.toggle('is-off', mode === 'off');
      e.g.classList.toggle('is-dim', mode === 'dim');
    }

    // 단계가 바뀌면 이전 패킷은 지우고 새 흐름으로 시작한다
    layers.packets.innerHTML = '';
    run.packets = [];
    run.bursts = [];
    run.flows = (st.flows || [])
      .filter((f) => edges[f.edge] && edges[f.edge].visible)
      .map((f) => {
        const iv = 1000 / (f.rate || 1);
        return Object.assign({}, f, { iv, acc: iv * (1 - Math.random() * 0.5) });
      });

    tickSweep(run, true);

    layers.callouts.innerHTML = '';
    for (const c of st.callouts || []) drawCallout(layers.callouts, nodes[c.node], c);

    refs.stepNo.textContent = `STEP ${String(run.index + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
    refs.stepTitle.textContent = st.title;
    refs.stepNote.textContent = st.note || '';
    refs.progress.style.width = '0%';
    refs.stepList.querySelectorAll('button').forEach((b, k) => {
      b.classList.toggle('is-current', k === run.index);
      b.setAttribute('aria-current', k === run.index ? 'step' : 'false');
    });

    applyFocus(run);
  }

  // 현재 단계에서 보이는 연결선 중 노드에 닿은 것
  function linkedEdges(run, id) {
    return Object.values(run.edges).filter((e) => e.visible && (e.from === id || e.to === id));
  }

  function select(run, id) {
    run.focus = id && run.nodes[id] ? id : null;
    applyFocus(run);
  }

  function applyFocus(run) {
    const { nodes, edges, refs } = run;
    const id = run.focus;
    const linked = id ? new Set(linkedEdges(run, id).map((e) => e.id)) : null;
    const near = new Set(id ? [id] : []);
    if (linked) for (const eid of linked) near.add(edges[eid].from).add(edges[eid].to);

    refs.stage.classList.toggle('has-focus', !!id);
    for (const nid in nodes) {
      nodes[nid].g.classList.toggle('is-focus', nid === id);
      nodes[nid].g.classList.toggle('is-near', !!id && near.has(nid) && nid !== id);
    }
    for (const eid in edges) edges[eid].g.classList.toggle('is-linked', !!linked && linked.has(eid));
    for (const p of run.packets) p.c.classList.toggle('is-muted', !!linked && !linked.has(p.e.id));
    run.linked = linked;

    refs.stepView.hidden = !!id;
    refs.nodeView.hidden = !id;
    if (id) renderInspector(run, id);
  }

  function renderInspector(run, id) {
    const { nodes, refs } = run;
    const node = nodes[id];
    const st = run.sc.steps[run.index];
    const box = refs.nodeView;
    box.innerHTML = '';

    const head = h('div', 'insp-head');
    const chip = h('span', `kind-chip kind-${node.kind}`);
    const ic = document.createElementNS(NS, 'svg');
    ic.setAttribute('viewBox', '0 0 16 16');
    el('path', { d: NODE_KINDS[node.kind].icon }, ic);
    chip.append(ic, NODE_KINDS[node.kind].name);
    const close = h('button', 'insp-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', '상세 닫기');
    close.onclick = () => select(run, null);
    head.append(chip, close);
    box.append(head);

    box.append(h('h2', 'insp-title', node.labelEl.textContent));
    const meta = h('div', 'insp-meta');
    if (node.subEl.textContent) meta.append(h('span', 'mono', node.subEl.textContent));
    meta.append(h('span', `state-chip is-${node.state}`, STATES[node.state] || node.state));
    box.append(meta);

    const stepNote = st.nodeNotes && st.nodeNotes[id];
    if (stepNote) {
      const sec = section('이 단계에서');
      sec.classList.add('insp-now');
      sec.append(h('p', null, stepNote));
      box.append(sec);
    }

    if (node.role) {
      const sec = section('역할');
      sec.append(h('p', null, node.role));
      box.append(sec);
    }

    if (node.details && node.details.length) {
      const sec = section('세부 구성');
      const dl = h('dl', 'insp-dl');
      for (const [k, v] of node.details) dl.append(h('dt', null, k), h('dd', null, v));
      sec.append(dl);
      box.append(sec);
    }

    if (node.notes && node.notes.length) {
      const sec = section('운영 포인트');
      const ul = h('ul', 'insp-notes');
      for (const t of node.notes) ul.append(h('li', null, t));
      sec.append(ul);
      box.append(sec);
    }

    const edgesNow = linkedEdges(run, id);
    const ins = edgesNow.filter((e) => e.to === id);
    const outs = edgesNow.filter((e) => e.from === id);
    if (ins.length || outs.length) {
      const sec = section('연결 (현재 단계)');
      if (ins.length) sec.append(linkRow(run, '들어옴', ins, 'from'));
      if (outs.length) sec.append(linkRow(run, '나감', outs, 'to'));
      box.append(sec);
    }
  }

  function section(title) {
    const sec = h('section', 'insp-sec');
    sec.append(h('h3', null, title));
    return sec;
  }

  function linkRow(run, title, list, side) {
    const row = h('div', 'insp-links');
    row.append(h('span', 'insp-links-title', title));
    const wrap = h('div', 'insp-chips');
    for (const e of list) {
      const other = run.nodes[e[side]];
      const b = h('button', `link-chip kind-${e.kind}`);
      b.type = 'button';
      // dim 상태 연결선은 그려져 있지만 흐름이 멈춘 것이므로 '중단'으로 표시한다
      b.append(h('i'), other.labelEl.textContent, h('small', null, e.mode === 'dim' ? `${run.kinds[e.kind]} · 중단` : run.kinds[e.kind]));
      b.onclick = () => select(run, other.id);
      wrap.append(b);
    }
    row.append(wrap);
    return row;
  }

  function spawn(run, f) {
    const e = run.edges[f.edge];
    const kind = f.fail ? 'fail' : f.kind || e.kind;
    const c = el('circle', { class: `pk pk-${kind}`, r: f.size || 5 }, run.layers.packets);
    if (run.linked && !run.linked.has(e.id)) c.classList.add('is-muted');
    run.packets.push({ c, e, fail: !!f.fail, t0: run.clock, dur: e.len / (SPEED * (f.speed || 1)) });
  }

  function update(run, dt) {
    tickSweep(run, false);
    for (const f of run.flows) {
      f.acc += dt;
      while (f.acc >= f.iv) {
        f.acc -= f.iv;
        spawn(run, f);
      }
    }

    run.packets = run.packets.filter((p) => {
      const prog = (run.clock - p.t0) / p.dur;
      const limit = p.fail ? FAIL_AT : 1;
      if (prog >= limit) {
        if (p.fail) {
          const pt = p.e.path.getPointAtLength(limit * p.e.len);
          const b = el('circle', { class: 'burst', cx: pt.x, cy: pt.y, r: 4 }, run.layers.packets);
          if (p.c.classList.contains('is-muted')) b.classList.add('is-muted');
          run.bursts.push({ b, t0: run.clock });
        }
        p.c.remove();
        return false;
      }
      const pt = p.e.path.getPointAtLength(prog * p.e.len);
      p.c.setAttribute('cx', pt.x);
      p.c.setAttribute('cy', pt.y);
      return true;
    });

    run.bursts = run.bursts.filter((b) => {
      const t = (run.clock - b.t0) / 600;
      if (t >= 1) {
        b.b.remove();
        return false;
      }
      b.b.setAttribute('r', 4 + t * 12);
      b.b.style.opacity = 1 - t;
      return true;
    });

    const hold = run.sc.steps[run.index].hold || DEFAULT_HOLD;
    const elapsed = run.clock - run.stepStart;
    run.refs.progress.style.width = run.auto ? `${Math.min(100, (elapsed / hold) * 100)}%` : '0%';
    if (run.auto && elapsed >= hold) go(run, run.index + 1);
  }

  function drawCallout(layer, node, c) {
    if (!node) return;
    const g = el('g', { class: `callout tone-${c.tone || 'info'}` }, layer);
    const y = c.below ? node.y + node.h / 2 + 24 : node.y - node.h / 2 - 16;
    const rect = el('rect', { rx: 8 }, g);
    const text = el('text', { x: node.x, y: y + 4 }, g);
    text.textContent = c.text;
    backplate(text, rect, 10, 5);
  }

  function renderLegend(box, sc, kinds) {
    const used = new Set(sc.edges.map((e) => e.kind || 'rw'));
    if (sc.steps.some((s) => (s.flows || []).some((f) => f.fail))) used.add('fail');
    box.innerHTML = '';
    for (const kind of Object.keys(KINDS)) {
      if (!used.has(kind)) continue;
      const item = h('span', `legend-item kind-${kind}`);
      item.append(h('i'), kinds[kind]);
      box.appendChild(item);
    }
  }

  function renderStepList(run) {
    const list = run.refs.stepList;
    list.innerHTML = '';
    run.sc.steps.forEach((st, k) => {
      const li = document.createElement('li');
      const b = h('button', null, st.title);
      b.type = 'button';
      b.addEventListener('click', () => go(run, k));
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  function bindSelection(run) {
    const svg = run.refs.stage;
    svg.addEventListener('click', (ev) => {
      const g = ev.target.closest('.node');
      select(run, g && g.dataset.id !== run.focus ? g.dataset.id : null);
    });
    svg.addEventListener('keydown', (ev) => {
      const g = ev.target.closest('.node');
      if (g && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        ev.stopPropagation();
        select(run, g.dataset.id);
      }
    });
  }

  function bindControls(run) {
    const { refs } = run;
    const setPaused = (v) => {
      run.paused = v;
      refs.play.textContent = v ? '재생' : '일시정지';
      refs.play.setAttribute('aria-pressed', String(!v));
    };
    const setAuto = (v) => {
      run.auto = v;
      refs.auto.setAttribute('aria-pressed', String(v));
      run.stepStart = run.clock;
    };
    refs.prev.onclick = () => go(run, run.index - 1);
    refs.next.onclick = () => go(run, run.index + 1);
    refs.play.onclick = () => setPaused(!run.paused);
    refs.auto.onclick = () => setAuto(!run.auto);
    document.addEventListener('keydown', (ev) => {
      if (ev.target.closest('input, textarea')) return;
      if (ev.key === 'ArrowRight') go(run, run.index + 1);
      else if (ev.key === 'ArrowLeft') go(run, run.index - 1);
      else if (ev.key === 'Escape') select(run, null);
      else if (ev.key === ' ') {
        ev.preventDefault();
        setPaused(!run.paused);
      } else if (ev.key === 'a') setAuto(!run.auto);
    });
    // 녹화용: ?auto=1 이면 자동 넘김으로 시작
    setAuto(new URLSearchParams(location.search).get('auto') === '1');
    setPaused(false);
  }

  window.ArchMotion = {
    scenario(sc) {
      registered = sc;
    },
    get current() {
      return registered;
    },
    mount,
  };
})();
