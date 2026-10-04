'use strict';

// 端到端：领料出库
// 工作室按已确认的独立铅条计划、独立裁片订单或整套用料单分次领料：
// 网页/API 可见各规格尚未领出的预留量；提交单据+唯一领料号+本次根数/各色张数，
// 同事务扣减实物库存与预留，留下不可变记录，返回本次/累计/余留；
// 任一项不合法整次不生效；同号同内容重试返回原记录，内容不同报冲突；
// 已领料单据不能取消，独立裁片订单也不能换单；未领料单据仍按原规则操作；
// 盘点/手工库存调整按结转后的库存与预留计算；领料历史可查。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39251';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `requisition-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pubId, MID, RID, GID;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/requisitions'); break; } catch { await sleep(50); }
  }
  // 铅条库存 10 根；红/绿原片各 5 张
  const m = await api('POST', '/api/materials', { name: '300料', length: 300, stock: 10 });
  MID = m.data.material.id;
  RID = (await api('POST', '/api/glass-sheets', { color: '#FF0000', width: 600, height: 400, stock: 5 })).data.sheet.id;
  GID = (await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 600, height: 400, stock: 5 })).data.sheet.id;

  const d = await api('POST', '/api/designs', { name: '领料测试窗', width: 100, height: 100 });
  designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, { color: '#ff0000', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]] });
  await api('POST', `/api/designs/${designId}/pieces`, { color: '#00ff00', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]] });
  pubId = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ---------- 独立铅条计划领料 ----------

test('铅条计划：确认后分次领料，库存与预留同步扣减、返回本次/累计/余留', async () => {
  const plan = (await api('POST', '/api/plans', { publicationId: pubId, materialId: MID, copies: 1, kerf: 0.5 })).data.plan;
  globalThis.PLAN = plan.id;
  const R = plan.requiredBars;
  assert.ok(R >= 1);
  assert.strictEqual((await api('POST', `/api/plans/${plan.id}/confirm`)).status, 200);

  // 确认后：库存 10、预留 R、可用 10-R、已领 0、余留 R
  const mat0 = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(mat0.stock, 10);
  assert.strictEqual(mat0.reserved, R);
  assert.strictEqual(mat0.drawn, 0);
  assert.strictEqual(mat0.available, 10 - R);

  // 未领预留量
  const rem = await api('GET', `/api/plans/${plan.id}/requisitions/remaining`);
  assert.strictEqual(rem.status, 200);
  assert.strictEqual(rem.data.remaining.lead.requiredBars, R);
  assert.strictEqual(rem.data.remaining.lead.drawnBars, 0);
  assert.strictEqual(rem.data.remaining.lead.remainingBars, R);

  // 第一次领 1 根
  const r1 = await api('POST', `/api/plans/${plan.id}/requisitions`, { code: 'LL-0001', leadBars: 1 });
  assert.strictEqual(r1.status, 201, JSON.stringify(r1.data));
  assert.strictEqual(r1.data.idempotent, false);
  assert.strictEqual(r1.data.thisTime.leadBars, 1);
  assert.strictEqual(r1.data.cumulative.leadBars, 1);
  assert.strictEqual(r1.data.remaining.lead.drawnBars, 1);
  assert.strictEqual(r1.data.remaining.lead.remainingBars, R - 1);
  assert.strictEqual(r1.data.requisition.leadBars, 1);
  assert.strictEqual(r1.data.requisition.docType, 'plan');

  // 实物库存与预留各减 1；可用量不变
  const mat1 = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(mat1.stock, 9);
  assert.strictEqual(mat1.reserved, R - 1);
  assert.strictEqual(mat1.drawn, 1);
  assert.strictEqual(mat1.available, 10 - R);

  // 同号同内容重试 → 返回原记录（幂等，不重复扣减）
  const retry = await api('POST', `/api/plans/${plan.id}/requisitions`, { code: 'LL-0001', leadBars: 1 });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);
  assert.strictEqual(retry.data.requisition.id, r1.data.requisition.id);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 9);

  // 同号不同内容（根数不同）→ 409 冲突，不生效
  const conflict = await api('POST', `/api/plans/${plan.id}/requisitions`, { code: 'LL-0001', leadBars: 2 });
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.data.code, 'code_conflict');
  assert.strictEqual(conflict.data.current.leadBars, 1);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 9);

  // 同号用于另一张单据 → 冲突
  const other = (await api('POST', '/api/plans', { name: '另一计划', publicationId: pubId, materialId: MID, copies: 1, kerf: 0.5 })).data.plan;
  await api('POST', `/api/plans/${other.id}/confirm`);
  const cross = await api('POST', `/api/plans/${other.id}/requisitions`, { code: 'LL-0001', leadBars: 1 });
  assert.strictEqual(cross.status, 409);
  assert.strictEqual(cross.data.code, 'code_conflict');
  // 另一计划未领料，取消后不影响本规格预留口径
  assert.strictEqual((await api('POST', `/api/plans/${other.id}/cancel`)).status, 200);
  globalThis.PLAN_OTHER = other.id;

  // 领剩余全部
  const r2 = await api('POST', `/api/plans/${plan.id}/requisitions`, { code: 'LL-0002', leadBars: R - 1 });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.data.cumulative.leadBars, R);
  assert.strictEqual(r2.data.remaining.lead.remainingBars, 0);
  const mat2 = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(mat2.stock, 10 - R);
  assert.strictEqual(mat2.reserved, 0);
  assert.strictEqual(mat2.drawn, R);
  assert.strictEqual(mat2.available, 10 - R);
});

test('铅条计划：非法数量整次不生效（超余留/零或负/小数/玻璃字段）', async () => {
  const id = globalThis.PLAN;
  const before = (await api('GET', `/api/materials/${MID}`)).data.material.stock;
  assert.strictEqual((await api('POST', `/api/plans/${id}/requisitions`, { code: 'LL-X1', leadBars: 1 })).status, 409);
  assert.strictEqual((await api('POST', `/api/plans/${id}/requisitions`, { code: 'LL-X2' })).status, 400);
  assert.strictEqual((await api('POST', `/api/plans/${id}/requisitions`, { code: 'LL-X3', leadBars: 0 })).status, 400);
  assert.strictEqual((await api('POST', `/api/plans/${id}/requisitions`, { code: 'LL-X4', leadBars: -1 })).status, 400);
  assert.strictEqual((await api('POST', `/api/plans/${id}/requisitions`, { code: 'LL-X5', leadBars: 1.5 })).status, 400);
  assert.strictEqual((await api('POST', `/api/plans/${id}/requisitions`, {
    code: 'LL-X6', leadBars: 0, glass: [{ color: '#ff0000', sheets: 1 }],
  })).status, 400);
  assert.strictEqual((await api('POST', `/api/plans/${id}/requisitions`, { leadBars: 1 })).status, 400); // 缺领料号
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, before);
});

test('铅条计划：已领料不能取消；未领料计划仍可取消', async () => {
  const c = await api('POST', `/api/plans/${globalThis.PLAN}/cancel`);
  assert.strictEqual(c.status, 409);
  assert.strictEqual(c.data.code, 'drawn_blocked');
  // 未领料的计划可正常取消（另建一张确认后取消）
  const fresh = (await api('POST', '/api/plans', { name: '未领料计划', publicationId: pubId, materialId: MID, copies: 1, kerf: 0.5 })).data.plan;
  assert.strictEqual((await api('POST', `/api/plans/${fresh.id}/confirm`)).status, 200);
  assert.strictEqual((await api('POST', `/api/plans/${fresh.id}/cancel`)).status, 200);
  // 已领料计划也不能删除（仍为 confirmed）
  assert.strictEqual((await api('DELETE', `/api/plans/${globalThis.PLAN}`)).status, 409);
  // 计划详情带累计/余留
  const p = (await api('GET', `/api/plans/${globalThis.PLAN}`)).data.plan;
  assert.strictEqual(p.drawnBars, p.requiredBars);
  assert.strictEqual(p.remainingBars, 0);
  assert.strictEqual(p.requisitioned, true);
});

// ---------- 独立裁片订单领料 ----------

test('裁片订单：确认后分色分次领料，逐色返回余留', async () => {
  const order = (await api('POST', '/api/cut-orders', { publicationId: pubId, copies: 1, gap: 0 })).data.order;
  globalThis.ORDER = order.id;
  assert.strictEqual((await api('POST', `/api/cut-orders/${order.id}/confirm`)).status, 200);
  const need = new Map(order.colors.map((c) => [c.color, c.requiredSheets]));

  const rem0 = await api('GET', `/api/cut-orders/${order.id}/requisitions/remaining`);
  assert.strictEqual(rem0.status, 200);
  for (const c of rem0.data.remaining.glass.colors) {
    assert.strictEqual(c.requiredSheets, need.get(c.color));
    assert.strictEqual(c.drawnSheets, 0);
    assert.strictEqual(c.remainingSheets, c.requiredSheets);
  }

  // 先领红 1 张（用 sheetId 也行，这里用颜色）
  const r1 = await api('POST', `/api/cut-orders/${order.id}/requisitions`, {
    code: 'CO-0001', glass: [{ color: '#ff0000', sheets: 1 }],
  });
  assert.strictEqual(r1.status, 201, JSON.stringify(r1.data));
  assert.strictEqual(r1.data.thisTime.glassSheets, 1);
  assert.strictEqual(r1.data.thisTime.glass[0].color, '#ff0000');
  const red = r1.data.remaining.glass.colors.find((c) => c.color === '#ff0000');
  const green = r1.data.remaining.glass.colors.find((c) => c.color === '#00ff00');
  assert.strictEqual(red.drawnSheets, 1);
  assert.strictEqual(red.remainingSheets, need.get('#ff0000') - 1);
  assert.strictEqual(green.drawnSheets, 0);
  assert.strictEqual(green.remainingSheets, need.get('#00ff00'));

  const redStock = (await api('GET', `/api/glass-sheets/${RID}`)).data.sheet;
  assert.strictEqual(redStock.stock, 4);
  assert.strictEqual(redStock.drawn, 1);
  assert.strictEqual(redStock.reserved, need.get('#ff0000') - 1);

  // 一次同时领红 + 绿
  const r2 = await api('POST', `/api/cut-orders/${order.id}/requisitions`, {
    code: 'CO-0002',
    glass: [
      { color: '#00FF00', sheets: need.get('#00ff00') }, // 大小写归一
      { sheetId: RID, sheets: need.get('#ff0000') - 1 },
    ],
  });
  assert.strictEqual(r2.status, 201, JSON.stringify(r2.data));
  assert.strictEqual(r2.data.remaining.glass.totalRemaining, 0);
  // 实物：红 5−need(红)，绿 5−need(绿)
  assert.strictEqual((await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock, 5 - need.get('#ff0000'));
  assert.strictEqual((await api('GET', `/api/glass-sheets/${GID}`)).data.sheet.stock, 5 - need.get('#00ff00'));
});

test('裁片订单：非法领料整次不生效（超余留/缺色/非成员色/全零/leadBars）', async () => {
  const id = globalThis.ORDER;
  const rb = await api('GET', `/api/glass-sheets/${RID}`).then((x) => x.data.sheet.stock);
  const gb = await api('GET', `/api/glass-sheets/${GID}`).then((x) => x.data.sheet.stock);
  // 超过该单红色余留（已领完）
  const over = await api('POST', `/api/cut-orders/${id}/requisitions`, {
    code: 'CO-X1', glass: [{ color: '#ff0000', sheets: 1 }],
  });
  assert.strictEqual(over.status, 409);
  assert.strictEqual(over.data.code, 'exceeds_remaining');
  assert.strictEqual(over.data.shortages[0].color, '#ff0000');
  assert.strictEqual(over.data.shortages[0].remaining, 0);
  // 非该单颜色
  await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 600, height: 400, stock: 5 });
  const notMember = await api('POST', `/api/cut-orders/${id}/requisitions`, {
    code: 'CO-X2', glass: [{ color: '#0000ff', sheets: 1 }],
  });
  assert.strictEqual(notMember.status, 400);
  assert.strictEqual(notMember.data.code, 'color_not_in_order');
  // 全零
  assert.strictEqual((await api('POST', `/api/cut-orders/${id}/requisitions`, {
    code: 'CO-X3', glass: [{ color: '#ff0000', sheets: 0 }],
  })).status, 400);
  // leadBars 不适用于裁片订单
  assert.strictEqual((await api('POST', `/api/cut-orders/${id}/requisitions`, {
    code: 'CO-X4', leadBars: 1,
  })).status, 400);
  // 同号不同内容冲突
  const cc = await api('POST', `/api/cut-orders/${id}/requisitions`, { code: 'CO-0001', glass: [{ color: '#ff0000', sheets: 1 }] });
  assert.strictEqual(cc.status, 200, '同号同内容重试应幂等');
  assert.strictEqual(cc.data.idempotent, true);
  const cc2 = await api('POST', `/api/cut-orders/${id}/requisitions`, { code: 'CO-0001', glass: [{ color: '#00ff00', sheets: 1 }] });
  assert.strictEqual(cc2.status, 409);
  assert.strictEqual(cc2.data.code, 'code_conflict');
  // 库存未被任何失败请求改动
  assert.strictEqual((await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock, rb);
  assert.strictEqual((await api('GET', `/api/glass-sheets/${GID}`)).data.sheet.stock, gb);
});

test('裁片订单：已领料不能取消也不能换单', async () => {
  const id = globalThis.ORDER;
  // 不能取消
  const cancel = await api('POST', `/api/cut-orders/${id}/cancel`);
  assert.strictEqual(cancel.status, 409);
  assert.strictEqual(cancel.data.code, 'drawn_blocked');
  // 不能换单：先发布 v2（改颜色），再尝试
  await api('PUT', `/api/designs/${designId}/pieces/1`, { color: '#0000ff', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]] });
  const pub2 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;
  globalThis.PUB2 = pub2.id;
  const rp = await api('POST', `/api/cut-orders/${id}/replacement/preview`, { targetVersion: 2 });
  assert.strictEqual(rp.status, 409);
  assert.strictEqual(rp.data.code, 'drawn_blocked');
  const rc = await api('POST', `/api/cut-orders/${id}/replacement`, { targetVersion: 2 });
  assert.strictEqual(rc.status, 409);
  assert.strictEqual(rc.data.code, 'drawn_blocked');
  // 订单详情带累计/余留
  const o = (await api('GET', `/api/cut-orders/${id}`)).data.order;
  assert.strictEqual(o.remainingSheets, 0);
  assert.strictEqual(o.requisitioned, true);
  assert.ok(o.colors.every((c) => c.drawnSheets === c.requiredSheets));
});

test('未领料的已确认订单仍可换单（原规则不变）', async () => {
  // 新订单按 v1 确认，不领料，然后换到 v2
  const o = (await api('POST', '/api/cut-orders', { publicationId: pubId, copies: 1, gap: 0 })).data.order;
  assert.strictEqual((await api('POST', `/api/cut-orders/${o.id}/confirm`)).status, 200);
  // v2 含蓝片，先确保蓝片库存足够（前面登记 5 张）
  const r = await api('POST', `/api/cut-orders/${o.id}/replacement`, { targetVersion: 2 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.order.status, 'confirmed');
  globalThis.NEW_ORDER = r.data.order.id;
  // 新单未领料，可取消
  assert.strictEqual((await api('POST', `/api/cut-orders/${r.data.order.id}/cancel`)).status, 200);
});

// ---------- 整套用料单领料 ----------

test('整套单：可只领一类；两类分次领料；已领不能取消', async () => {
  // 恢复库存（前面测试消耗）：铅条补到 10、红 5、绿 5、蓝 5
  await api('PATCH', `/api/materials/${MID}`, { stock: 10 });
  await api('PATCH', `/api/glass-sheets/${RID}`, { stock: 5 });
  await api('PATCH', `/api/glass-sheets/${GID}`, { stock: 5 });

  const combo = (await api('POST', '/api/combo-orders', {
    name: '领料整套', publicationId: pubId, materialId: MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'combo-req-1',
  })).data.combo;
  globalThis.COMBO = combo.id;
  const needBars = combo.requiredBars;
  const needRed = combo.cutOrder.colors.find((c) => c.color === '#ff0000').requiredSheets;

  // 余留视图同时含铅条与玻璃
  const rem = await api('GET', `/api/combo-orders/${combo.id}/requisitions/remaining`);
  assert.strictEqual(rem.data.remaining.lead.remainingBars, needBars);
  assert.ok(rem.data.remaining.glass.colors.find((c) => c.color === '#ff0000'));

  // 只领铅条（整套允许只领一类）
  const r1 = await api('POST', `/api/combo-orders/${combo.id}/requisitions`, {
    code: 'CB-0001', leadBars: 1,
  });
  assert.strictEqual(r1.status, 201, JSON.stringify(r1.data));
  assert.strictEqual(r1.data.thisTime.leadBars, 1);
  assert.strictEqual(r1.data.thisTime.glassSheets, 0);
  assert.strictEqual(r1.data.remaining.lead.remainingBars, needBars - 1);
  const mat = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(mat.stock, 9);
  assert.strictEqual(mat.reserved, needBars - 1);

  // 只领玻璃（红色 1 张）
  const r2 = await api('POST', `/api/combo-orders/${combo.id}/requisitions`, {
    code: 'CB-0002', glass: [{ color: '#ff0000', sheets: 1 }],
  });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.data.thisTime.leadBars, 0);
  assert.strictEqual((await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock, 4);

  // 全零请求 400
  assert.strictEqual((await api('POST', `/api/combo-orders/${combo.id}/requisitions`, {
    code: 'CB-X1', leadBars: 0, glass: [],
  })).status, 400);
  // 超余留（铅条）整次失败——即使同时带了合法玻璃项也不生效
  const redStockBefore = (await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock;
  const over = await api('POST', `/api/combo-orders/${combo.id}/requisitions`, {
    code: 'CB-X2', leadBars: needBars, glass: [{ color: '#ff0000', sheets: 1 }],
  });
  assert.strictEqual(over.status, 409);
  assert.strictEqual(over.data.code, 'exceeds_remaining');
  assert.strictEqual((await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock, redStockBefore, '整次失败玻璃未扣');

  // 已领（任一类）不能取消整套
  const cancel = await api('POST', `/api/combo-orders/${combo.id}/cancel`);
  assert.strictEqual(cancel.status, 409);
  assert.strictEqual(cancel.data.code, 'drawn_blocked');
  assert.strictEqual(cancel.data.drawnBars, 1);
  assert.strictEqual(cancel.data.drawnSheets, 1);

  // 同号同内容重试幂等
  const retry = await api('POST', `/api/combo-orders/${combo.id}/requisitions`, { code: 'CB-0001', leadBars: 1 });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 9);

  // 关联单不能通过领料接口直接提交
  const lp = combo.leadPlanId;
  const locked = await api('POST', `/api/plans/${lp}/requisitions`, { code: 'CB-LOCK', leadBars: 1 });
  assert.strictEqual(locked.status, 409);
  assert.strictEqual(locked.data.code, 'combo_locked');

  // 整套详情含累计/余留
  const c2 = (await api('GET', `/api/combo-orders/${combo.id}`)).data.combo;
  assert.strictEqual(c2.drawnBars, 1);
  assert.strictEqual(c2.remainingBars, needBars - 1);
  assert.strictEqual(c2.drawnSheets, 1);
  assert.strictEqual(c2.requisitioned, true);
  assert.ok(needRed >= 1);
});

test('整套单：未领料的整套单仍可取消（两类预留各释放一次）', async () => {
  const combo = (await api('POST', '/api/combo-orders', {
    name: '未领料整套', publicationId: pubId, materialId: MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'combo-req-2',
  })).data.combo;
  assert.strictEqual((await api('POST', `/api/combo-orders/${combo.id}/cancel`)).status, 200);
  assert.strictEqual((await api('POST', `/api/combo-orders/${combo.id}/cancel`)).status, 409);
});

// ---------- 历史查询 ----------

test('领料历史：单据维度与全局维度可查，记录不可变', async () => {
  const h = await api('GET', `/api/plans/${globalThis.PLAN}/requisitions`);
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.data.count, 2);
  assert.deepStrictEqual(h.data.requisitions.map((r) => r.code), ['LL-0001', 'LL-0002']);

  const all = await api('GET', '/api/requisitions');
  assert.ok(all.data.count >= 5);
  const cb = all.data.requisitions.find((r) => r.code === 'CB-0002');
  assert.strictEqual(cb.docType, 'combo');
  assert.strictEqual(cb.glassSheets, 1);
  assert.strictEqual(cb.lines.glass[0].color, '#ff0000');

  const byCode = await api('GET', '/api/requisitions?code=LL-0001');
  assert.strictEqual(byCode.data.count, 1);
  const byDoc = await api('GET', '/api/requisitions?docType=combo&docId=1');
  assert.ok(byDoc.data.requisitions.every((r) => r.docType === 'combo'));
  assert.strictEqual((await api('GET', `/api/requisitions/${cb.id}`)).status, 200);
  assert.strictEqual((await api('GET', '/api/requisitions/99999')).status, 404);
});

// ---------- 盘点 / 手工调整 按结转后的库存与预留计算 ----------

test('盘点与手工库存调整：按“库存 − 有效预留（含已领扣减）”口径', async () => {
  // 铅条：当前实物库存 9（整套 CB 领了 1），有效预留 needBars-1（整套剩）+ 计划已领完 0
  const matNow = (await api('GET', `/api/materials/${MID}`)).data.material;
  const combo = (await api('GET', `/api/combo-orders/${globalThis.COMBO}`)).data.combo;
  assert.strictEqual(matNow.stock, 9);
  assert.strictEqual(matNow.reserved, combo.remainingBars);

  // 手工调整库存不得低于有效预留：调低到 reserved-1 被拒
  const low = await api('PATCH', `/api/materials/${MID}`, { stock: combo.remainingBars - 1 });
  assert.strictEqual(low.status, 409);
  // 调到恰好有效预留可以
  assert.strictEqual((await api('PATCH', `/api/materials/${MID}`, { stock: combo.remainingBars })).status, 200);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.available, 0);
  // 已领部分不会阻止（它不在有效预留里）
  await api('PATCH', `/api/materials/${MID}`, { stock: 9 });

  // 盘点：实盘 = 6（≥ 有效预留 combo.remainingBars ≤ needBars）
  const st = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID, counted: 6 }],
  });
  const item = st.data.stocktake.items[0];
  assert.strictEqual(item.reserved, combo.remainingBars);
  const cr = await api('POST', `/api/stocktakes/${st.data.stocktake.id}/confirm`);
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.data));
  const matAfter = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(matAfter.stock, 6);
  assert.strictEqual(matAfter.reserved, combo.remainingBars);
  assert.strictEqual(matAfter.available, 6 - combo.remainingBars);

  // 盘点后把整套剩余铅条继续领完（按结转库存）
  if (combo.remainingBars > 0) {
    const fin = await api('POST', `/api/combo-orders/${globalThis.COMBO}/requisitions`, {
      code: 'CB-FIN', leadBars: combo.remainingBars,
    });
    assert.strictEqual(fin.status, 201, JSON.stringify(fin.data));
    const m3 = (await api('GET', `/api/materials/${MID}`)).data.material;
    assert.strictEqual(m3.stock, 6 - combo.remainingBars);
    assert.strictEqual(m3.reserved, 0);
  }
});

test('并发同一领料号：只有一笔成功落库（另一笔幂等或冲突，均不重复扣库存）', async () => {
  // 用一张新确认的订单做并发：建一张订单（v1 红+绿），库存补足
  await api('PATCH', `/api/glass-sheets/${RID}`, { stock: 20 });
  await api('PATCH', `/api/glass-sheets/${GID}`, { stock: 20 });
  const o = (await api('POST', '/api/cut-orders', { publicationId: pubId, copies: 2, gap: 0 })).data.order;
  assert.strictEqual((await api('POST', `/api/cut-orders/${o.id}/confirm`)).status, 200);
  const redNeed = o.colors.find((c) => c.color === '#ff0000').requiredSheets;
  const stockBefore = (await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock;

  const [a, b] = await Promise.all([
    api('POST', `/api/cut-orders/${o.id}/requisitions`, { code: 'RACE-1', glass: [{ color: '#ff0000', sheets: 1 }] }),
    api('POST', `/api/cut-orders/${o.id}/requisitions`, { code: 'RACE-1', glass: [{ color: '#ff0000', sheets: 1 }] }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.ok(codes[0] === 200 && codes[1] === 201, JSON.stringify({ a, b }));
  assert.ok(a.data.requisition.id === b.data.requisition.id);
  const stockAfter = (await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock;
  assert.strictEqual(stockAfter, stockBefore - 1, '同号并发只扣一次');
  assert.strictEqual(redNeed >= 1, true);
});

test('草稿/已取消/不存在的单据不能领料（409/404）', async () => {
  const draft = (await api('POST', '/api/plans', { name: '草稿计划', publicationId: pubId, materialId: MID, copies: 1, kerf: 0.5 })).data.plan;
  assert.strictEqual((await api('POST', `/api/plans/${draft.id}/requisitions`, { code: 'D-1', leadBars: 1 })).status, 409);
  assert.strictEqual((await api('POST', '/api/plans/99999/requisitions', { code: 'D-2', leadBars: 1 })).status, 404);
  assert.strictEqual((await api('GET', '/api/requisitions?docType=plan')).status, 400); // 缺 docId
  assert.strictEqual((await api('GET', '/api/requisitions?docType=wood')).status, 400); // 非法类型
});
