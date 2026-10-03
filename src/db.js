'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 一张图纸（窗框固定）；草稿内容在 pieces 表中就地编辑
    CREATE TABLE IF NOT EXISTS designs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      width_mm    INTEGER NOT NULL CHECK (width_mm  > 0),
      height_mm   INTEGER NOT NULL CHECK (height_mm > 0),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 草稿拼片：编号在一张图纸内递增且永不复用
    CREATE TABLE IF NOT EXISTS pieces (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      piece_no    INTEGER NOT NULL,
      color       TEXT    NOT NULL,
      polygon     TEXT    NOT NULL,           -- JSON [[x,y],...] 整数毫米
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, piece_no)
    );

    -- 发布版：不可变快照，版本号在一张图纸内递增
    CREATE TABLE IF NOT EXISTS publications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      snapshot    TEXT    NOT NULL,           -- 完整快照 JSON
      published_at TEXT   NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, version)
    );

    -- 铅条原材：一种规格（定尺长度）一行，登记库存根数
    CREATE TABLE IF NOT EXISTS lead_materials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,    -- 规格名（如“6m 通用铅条”）
      length_h    INTEGER NOT NULL CHECK (length_h > 0),   -- 定尺，整数“厘”（0.01mm）
      stock       INTEGER NOT NULL CHECK (stock >= 0),     -- 库存根数（不会为负）
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 铅条生产计划：草稿不预留库存；confirmed 原子预留；canceled 释放。
    -- 绑定发布快照（publication 不可变）；草稿变化/新版本均不影响已确认计划。
    CREATE TABLE IF NOT EXISTS lead_plans (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      status           TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled')),
      publication_id   INTEGER NOT NULL REFERENCES publications(id),
      design_id        INTEGER NOT NULL,
      version          INTEGER NOT NULL,
      material_id      INTEGER NOT NULL REFERENCES lead_materials(id),
      material_name    TEXT    NOT NULL,       -- 快照：确认时的规格名
      material_length_h INTEGER NOT NULL,      -- 快照：建计划时的定尺（厘）
      copies           INTEGER NOT NULL CHECK (copies > 0),
      kerf_h           INTEGER NOT NULL CHECK (kerf_h >= 0),  -- 每刀损耗（厘）
      required_bars    INTEGER NOT NULL CHECK (required_bars > 0),
      segment_count    INTEGER NOT NULL,
      layout           TEXT    NOT NULL,       -- 切段方案 JSON（毫米，排产结果快照）
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at     TEXT,
      canceled_at      TEXT,
      combo_id         INTEGER                 -- 非空=整套单关联计划（仅随整套单取消），NULL=独立计划
    );

    CREATE INDEX IF NOT EXISTS idx_pieces_design ON pieces(design_id);
    CREATE INDEX IF NOT EXISTS idx_pub_design    ON publications(design_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status  ON lead_plans(status);
    CREATE INDEX IF NOT EXISTS idx_plans_pub     ON lead_plans(publication_id);
    CREATE INDEX IF NOT EXISTS idx_plans_mat     ON lead_plans(material_id);

    -- 彩色玻璃原片：每种颜色一行规格（宽×高，整数毫米 1–2000）+ 库存张数
    CREATE TABLE IF NOT EXISTS glass_sheets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      color       TEXT    NOT NULL UNIQUE,        -- 归一化小写 #rrggbb
      width_mm    INTEGER NOT NULL CHECK (width_mm  BETWEEN 1 AND 2000),
      height_mm   INTEGER NOT NULL CHECK (height_mm BETWEEN 1 AND 2000),
      stock       INTEGER NOT NULL CHECK (stock >= 0),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 裁片订单：草稿不占库存；confirmed 原子预留各色原片；canceled 释放。
    -- confirmed 订单换单成功后置为 replaced（旧单退出预留、不可再取消/修改/删除，仅可查阅）。
    -- 绑定发布快照（publication 不可变）；草稿变化/再发布不影响已确认订单。
    CREATE TABLE IF NOT EXISTS cut_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      status        TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled','replaced')),
      publication_id INTEGER NOT NULL REFERENCES publications(id),
      design_id     INTEGER NOT NULL,
      version       INTEGER NOT NULL,
      copies        INTEGER NOT NULL CHECK (copies > 0),
      gap_mm        INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
      total_sheets  INTEGER NOT NULL CHECK (total_sheets BETWEEN 1 AND 60),
      layout        TEXT    NOT NULL,             -- 完整排样方案 JSON（含逐张放置坐标/轮廓）
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at  TEXT,
      canceled_at   TEXT,
      replaced_at   TEXT,
      combo_id      INTEGER                   -- 非空=整套单关联订单（仅随整套单取消，禁止改/换单/删），NULL=独立订单
    );

    -- 换单记录：一张已确认旧单（old_order_id）在同一事务内退出预留，
    -- 由按同一图纸另一已发布版本排出的新单（new_order_id，创建即 confirmed）接替。
    -- 幂等键：同一旧单只有一条记录；相同目标版本/件数/间距重试返回原新单，不同参数冲突。
    CREATE TABLE IF NOT EXISTS cut_order_replacements (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      old_order_id          INTEGER NOT NULL REFERENCES cut_orders(id),
      new_order_id          INTEGER NOT NULL REFERENCES cut_orders(id),
      target_publication_id INTEGER NOT NULL REFERENCES publications(id),
      copies                INTEGER NOT NULL CHECK (copies > 0),
      gap_mm                INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
      created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (old_order_id),
      UNIQUE (new_order_id)
    );

    -- 订单分色明细：确认时按色预留 required_sheets 张（原子）。
    -- sheet_color/width_mm/height_mm 为建单时快照；规格宽高属于身份不可改。
    CREATE TABLE IF NOT EXISTS cut_order_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id        INTEGER NOT NULL REFERENCES cut_orders(id) ON DELETE CASCADE,
      sheet_id        INTEGER NOT NULL REFERENCES glass_sheets(id),
      sheet_color     TEXT    NOT NULL,
      sheet_width_mm  INTEGER NOT NULL,
      sheet_height_mm INTEGER NOT NULL,
      required_sheets INTEGER NOT NULL CHECK (required_sheets > 0)
    );

    -- 整套用料单：一次确认同时预留铅条原材与各色玻璃原片。
    -- 确认在同一事务内核验并创建“关联的生产计划 + 裁片订单”（均创建即 confirmed）；
    -- 取消在同一事务内把两者置为 canceled，两类预留各释放一次。
    -- request_key 为客户端幂等键：重复确认（重试）返回原整套单，不重复预留库存。
    -- 关联的计划/订单只能随整套单存在/取消，不能从原独立入口单独取消、修改、换单或删除。
    CREATE TABLE IF NOT EXISTS combo_orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      status      TEXT    NOT NULL CHECK (status IN ('confirmed','canceled')),
      request_key TEXT    NOT NULL UNIQUE,
      publication_id INTEGER NOT NULL REFERENCES publications(id),
      design_id   INTEGER NOT NULL,
      version     INTEGER NOT NULL,
      copies      INTEGER NOT NULL CHECK (copies > 0),
      kerf_h      INTEGER NOT NULL CHECK (kerf_h >= 0),
      gap_mm      INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
      material_id INTEGER NOT NULL REFERENCES lead_materials(id),
      required_bars   INTEGER NOT NULL CHECK (required_bars > 0),
      total_sheets    INTEGER NOT NULL CHECK (total_sheets BETWEEN 1 AND 60),
      lead_plan_id    INTEGER NOT NULL,
      cut_order_id    INTEGER NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      canceled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_combo_status ON combo_orders(status);
    CREATE INDEX IF NOT EXISTS idx_combo_pub    ON combo_orders(publication_id);

    CREATE INDEX IF NOT EXISTS idx_cutorders_status ON cut_orders(status);
    CREATE INDEX IF NOT EXISTS idx_cutorders_pub    ON cut_orders(publication_id);
    CREATE INDEX IF NOT EXISTS idx_cutitems_sheet   ON cut_order_items(sheet_id);
    CREATE INDEX IF NOT EXISTS idx_cutitems_order   ON cut_order_items(order_id);

    -- 库存盘点单：一张单同时盘点若干铅条原材规格与玻璃原片规格。
    -- 预览即建草稿并固化各项“预览基准”（系统库存/已确认预留），预览本身不改库存；
    -- 确认在同一事务内按基准重核全部项：任一项基准已不符或实盘数低于当前预留则整单不生效；
    -- 全部通过才一次更新各规格库存，并保留原值、实盘值与确认时间。
    CREATE TABLE IF NOT EXISTS stocktakes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      status       TEXT    NOT NULL CHECK (status IN ('draft','confirmed')),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT
    );

    -- 盘点项：type='lead' 为铅条原材（spec_id -> lead_materials.id）；
    -- type='glass' 为玻璃原片（spec_id -> glass_sheets.id）。同单同类型规格唯一。
    -- 预览时固化基线库存与已确认预留；确认后保留原值与实盘值（永久记录，库存之后再变也不回写）。
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_id      INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
      type              TEXT    NOT NULL CHECK (type IN ('lead','glass')),
      spec_id           INTEGER NOT NULL,
      spec_name         TEXT    NOT NULL,       -- 铅条规格名；玻璃存颜色
      spec_length_h     INTEGER,                -- 仅铅条：定尺（厘），身份快照
      spec_width_mm     INTEGER,                -- 仅玻璃：宽（mm），身份快照
      spec_height_mm    INTEGER,                -- 仅玻璃：高（mm），身份快照
      baseline_stock    INTEGER NOT NULL,       -- 预览时系统库存
      baseline_reserved INTEGER NOT NULL,       -- 预览时已确认独立单+整套单预留
      counted_stock     INTEGER NOT NULL CHECK (counted_stock >= 0), -- 实盘总数
      UNIQUE (stocktake_id, type, spec_id)
    );

    CREATE INDEX IF NOT EXISTS idx_stockitems_st ON stocktake_items(stocktake_id);
  `);

  // 旧库迁移：早期 cut_orders 的状态 CHECK 不含 'replaced'，也没有 replaced_at 列。
  // 按 SQLite 官方表重建流程改表（保留全部行与 id；cut_order_items 通过 FK 关联，重建期间关闭 FK 检查）。
  // 必须先于 combo_id 加列迁移：表重建不带 combo_id，随后统一补列。
  migrateCutOrders();

  // 旧库迁移：早期 lead_plans / cut_orders 没有 combo_id（整套单关联）列。
  migrateComboColumn('lead_plans');
  migrateComboColumn('cut_orders');
  // 关联列索引（新库/旧库统一在此创建，确保列已存在）
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_plans_combo ON lead_plans(combo_id);
    CREATE INDEX IF NOT EXISTS idx_cutorders_combo ON cut_orders(combo_id);
  `);

  return db;
}

// 为旧库补 combo_id 列（NULL = 独立计划/订单；非空 = 属于某整套单，受整单状态机约束）。
// 不建 FK 约束（整套单与关联单在同一事务内先后插入，且历史表不带该列），由应用层保证一致。
function migrateComboColumn(table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('combo_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN combo_id INTEGER`);
  }
}

function migrateCutOrders() {
  const cols = db.prepare("PRAGMA table_info(cut_orders)").all().map((c) => c.name);
  if (cols.length === 0 || cols.includes('replaced_at')) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE cut_orders_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        status        TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled','replaced')),
        publication_id INTEGER NOT NULL REFERENCES publications(id),
        design_id     INTEGER NOT NULL,
        version       INTEGER NOT NULL,
        copies        INTEGER NOT NULL CHECK (copies > 0),
        gap_mm        INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
        total_sheets  INTEGER NOT NULL CHECK (total_sheets BETWEEN 1 AND 60),
        layout        TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        confirmed_at  TEXT,
        canceled_at   TEXT,
        replaced_at   TEXT
      );
      INSERT INTO cut_orders_new
        (id, name, status, publication_id, design_id, version, copies, gap_mm, total_sheets,
         layout, created_at, updated_at, confirmed_at, canceled_at)
      SELECT id, name, status, publication_id, design_id, version, copies, gap_mm, total_sheets,
         layout, created_at, updated_at, confirmed_at, canceled_at
      FROM cut_orders;
      DROP TABLE cut_orders;
      ALTER TABLE cut_orders_new RENAME TO cut_orders;
      CREATE INDEX IF NOT EXISTS idx_cutorders_status ON cut_orders(status);
      CREATE INDEX IF NOT EXISTS idx_cutorders_pub    ON cut_orders(publication_id);
    `);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function getDb() {
  if (!db) throw new Error('数据库未初始化');
  return db;
}

// ---------- designs ----------

function createDesign({ name, width, height }) {
  const info = getDb()
    .prepare('INSERT INTO designs (name, width_mm, height_mm) VALUES (?, ?, ?)')
    .run(name, width, height);
  return getDesign(info.lastInsertRowid);
}

function getDesign(id) {
  return getDb().prepare('SELECT * FROM designs WHERE id = ?').get(id);
}

function listDesigns() {
  return getDb().prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM pieces p WHERE p.design_id = d.id) AS piece_count,
      (SELECT MAX(version) FROM publications pu WHERE pu.design_id = d.id) AS latest_version
    FROM designs d ORDER BY d.id
  `).all();
}

// ---------- pieces ----------

function rowToPiece(row) {
  return {
    id: row.id,
    pieceNo: row.piece_no,
    color: row.color,
    polygon: JSON.parse(row.polygon),
    createdAt: row.created_at,
  };
}

function listPieces(designId) {
  return getDb()
    .prepare('SELECT * FROM pieces WHERE design_id = ? ORDER BY piece_no')
    .all(designId)
    .map(rowToPiece);
}

function getPiece(designId, pieceId) {
  const row = getDb()
    .prepare('SELECT * FROM pieces WHERE id = ? AND design_id = ?')
    .get(pieceId, designId);
  return row ? rowToPiece(row) : null;
}

function nextPieceNo(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(piece_no), 0) + 1 AS n FROM pieces WHERE design_id = ?')
    .get(designId);
  return row.n;
}

function addPiece(designId, { color, polygon }) {
  const pieceNo = nextPieceNo(designId);
  const info = getDb()
    .prepare('INSERT INTO pieces (design_id, piece_no, color, polygon) VALUES (?, ?, ?, ?)')
    .run(designId, pieceNo, color, JSON.stringify(polygon));
  touchDesign(designId);
  return getPiece(designId, info.lastInsertRowid);
}

function updatePiece(designId, pieceId, { color, polygon }) {
  const existing = getPiece(designId, pieceId);
  if (!existing) return null;
  getDb().prepare('UPDATE pieces SET color = ?, polygon = ? WHERE id = ? AND design_id = ?')
    .run(color, JSON.stringify(polygon), pieceId, designId);
  touchDesign(designId);
  return getPiece(designId, pieceId);
}

function deletePiece(designId, pieceId) {
  const info = getDb()
    .prepare('DELETE FROM pieces WHERE id = ? AND design_id = ?')
    .run(pieceId, designId);
  if (info.changes) touchDesign(designId);
  return info.changes > 0;
}

function replaceAllPieces(designId, pieces) {
  // 目前未使用；保留以便整单导入
  const tx = getDb().transaction((rows) => {
    getDb().prepare('DELETE FROM pieces WHERE design_id = ?').run(designId);
    for (const pc of rows) addPiece(designId, pc);
  });
  tx(pieces);
}

function touchDesign(designId) {
  getDb().prepare("UPDATE designs SET updated_at = datetime('now') WHERE id = ?").run(designId);
}

// ---------- publications ----------

function publishVersion(designId, snapshot) {
  const next = nextVersion(designId);
  const info = getDb()
    .prepare('INSERT INTO publications (design_id, version, snapshot) VALUES (?, ?, ?)')
    .run(designId, next, JSON.stringify(snapshot));
  return getPublication(designId, info.lastInsertRowid);
}

function nextVersion(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM publications WHERE design_id = ?')
    .get(designId);
  return row.v;
}

function getPublication(designId, pubId) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE id = ? AND design_id = ?')
    .get(pubId, designId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function getPublicationByVersion(designId, version) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE design_id = ? AND version = ?')
    .get(designId, version);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function listPublications(designId) {
  return getDb()
    .prepare('SELECT id, version, published_at FROM publications WHERE design_id = ? ORDER BY version DESC')
    .all(designId)
    .map((r) => ({ id: r.id, version: r.version, publishedAt: r.published_at }));
}

// ---------- 铅条原材 ----------

function rowToMaterial(row) {
  return {
    id: row.id,
    name: row.name,
    length: row.length_h / 100,          // 毫米
    stock: row.stock,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 各规格当前已被已确认计划预留的根数
function reservedMap() {
  const rows = getDb()
    .prepare(`SELECT material_id AS id, COALESCE(SUM(required_bars), 0) AS reserved
              FROM lead_plans WHERE status = 'confirmed' GROUP BY material_id`)
    .all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.reserved);
  return m;
}

function listMaterials() {
  const reserved = reservedMap();
  return getDb()
    .prepare('SELECT * FROM lead_materials ORDER BY id')
    .all()
    .map((r) => {
      const m = rowToMaterial(r);
      const used = reserved.get(r.id) || 0;
      m.reserved = used;
      m.available = m.stock - used;
      return m;
    });
}

function getMaterialRow(id) {
  return getDb().prepare('SELECT * FROM lead_materials WHERE id = ?').get(id);
}

function getMaterial(id) {
  const row = getMaterialRow(id);
  if (!row) return null;
  const m = rowToMaterial(row);
  const reserved = getDb()
    .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(id).n;
  m.reserved = reserved;
  m.available = m.stock - reserved;
  return m;
}

function getMaterialByName(name) {
  return getDb().prepare('SELECT * FROM lead_materials WHERE name = ?').get(name) || null;
}

function createMaterial({ name, lengthH, stock }) {
  const info = getDb()
    .prepare('INSERT INTO lead_materials (name, length_h, stock) VALUES (?, ?, ?)')
    .run(name, lengthH, stock);
  return getMaterial(info.lastInsertRowid);
}

// 仅允许改名称与库存根数（定尺属于规格身份，改定尺请新建规格）。
// 库存校验在事务中完成：不得小于已预留根数，库存永不为负由 CHECK 兜底。
function updateMaterial(id, { name, stock }) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getMaterialRow(id);
    if (!row) return { code: 'not_found' };
    const reserved = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(id).n;
    if (stock !== undefined && stock < reserved) {
      return { code: 'stock_below_reserved', reserved };
    }
    if (name !== undefined) {
      const dup = d.prepare('SELECT id FROM lead_materials WHERE name = ? AND id <> ?').get(name, id);
      if (dup) return { code: 'name_taken' };
      d.prepare("UPDATE lead_materials SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    }
    if (stock !== undefined) {
      d.prepare("UPDATE lead_materials SET stock = ?, updated_at = datetime('now') WHERE id = ?").run(stock, id);
    }
    return { code: 'ok', material: getMaterial(id) };
  });
  return txn.immediate();
}

// ---------- 铅条生产计划 ----------

function getPublicationById(pubId) {
  const row = getDb().prepare('SELECT * FROM publications WHERE id = ?').get(pubId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function createPlan(p) {
  const info = getDb()
    .prepare(`INSERT INTO lead_plans
      (name, status, publication_id, design_id, version, material_id, material_name,
       material_length_h, copies, kerf_h, required_bars, segment_count, layout)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.name, p.publicationId, p.designId, p.version, p.materialId,
      p.materialName, p.materialLengthH, p.copies, p.kerfH, p.requiredBars,
      p.segmentCount, JSON.stringify(p.layout));
  return getPlan(info.lastInsertRowid);
}

function getPlanRow(id) {
  return getDb().prepare('SELECT * FROM lead_plans WHERE id = ?').get(id);
}

function rowToPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    materialId: row.material_id,
    materialName: row.material_name,
    materialLength: row.material_length_h / 100,
    copies: row.copies,
    kerf: row.kerf_h / 100,
    requiredBars: row.required_bars,
    segmentCount: row.segment_count,
    layout: JSON.parse(row.layout),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    canceledAt: row.canceled_at || null,
    comboId: row.combo_id ?? null,
  };
}

function getPlan(id) {
  return rowToPlan(getPlanRow(id));
}

function listPlans() {
  return getDb().prepare('SELECT * FROM lead_plans ORDER BY id DESC').all().map(rowToPlan);
}

function updatePlanDraft(id, p) {
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status !== 'draft') return { code: 'not_draft', status: row.status };
  getDb()
    .prepare(`UPDATE lead_plans SET
       name = ?, publication_id = ?, design_id = ?, version = ?, material_id = ?,
       material_name = ?, material_length_h = ?, copies = ?, kerf_h = ?,
       required_bars = ?, segment_count = ?, layout = ?, updated_at = datetime('now')
     WHERE id = ?`)
    .run(p.name, p.publicationId, p.designId, p.version, p.materialId,
      p.materialName, p.materialLengthH, p.copies, p.kerfH, p.requiredBars,
      p.segmentCount, JSON.stringify(p.layout), id);
  return { code: 'ok', plan: getPlan(id) };
}

// 确认：原子预留库存。BEGIN IMMEDIATE 取写锁，保证多个计划并发确认绝不超卖。
function confirmPlan(id) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = getPlanRow(id);
    if (!row) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (row.combo_id) { d.exec('ROLLBACK'); return { code: 'combo_locked', comboId: row.combo_id }; }
    if (row.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'already_confirmed' }; }
    if (row.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'plan_canceled' }; }

    const mat = getMaterialRow(row.material_id);
    if (!mat) { d.exec('ROLLBACK'); return { code: 'material_missing' }; }
    // 规格定尺在建计划后被改动属于不支持的身份变更（当前接口禁止改定尺），双保险
    if (mat.length_h !== row.material_length_h) {
      d.exec('ROLLBACK'); return { code: 'material_changed' };
    }
    const reserved = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(row.material_id).n;
    const available = mat.stock - reserved;
    if (row.required_bars > available) {
      d.exec('ROLLBACK');
      return { code: 'shortage', available, required: row.required_bars, shortage: row.required_bars - available };
    }
    d.prepare(`UPDATE lead_plans
      SET status = 'confirmed', material_name = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'`).run(mat.name, id);
    d.exec('COMMIT');
    return { code: 'ok', plan: getPlan(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消：只有已确认计划会释放预留；重复取消不会再次改变库存。
function cancelPlan(id) {
  const d = getDb();
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status === 'draft') return { code: 'draft_not_reserved' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare(`UPDATE lead_plans
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(id);
    d.exec('COMMIT');
    return { code: 'ok', plan: getPlan(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function deletePlan(id) {
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  getDb().prepare('DELETE FROM lead_plans WHERE id = ?').run(id);
  return { code: 'ok' };
}

// ---------- 彩色玻璃原片 ----------

function rowToGlassSheet(row, reserved = 0) {
  return {
    id: row.id,
    color: row.color,
    width: row.width_mm,
    height: row.height_mm,
    stock: row.stock,
    reserved,
    available: row.stock - reserved,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 各颜色已被已确认订单预留的张数
function glassReservedMap() {
  const rows = getDb()
    .prepare(`SELECT i.sheet_id AS id, COALESCE(SUM(i.required_sheets), 0) AS reserved
              FROM cut_order_items i
              JOIN cut_orders o ON o.id = i.order_id
              WHERE o.status = 'confirmed'
              GROUP BY i.sheet_id`)
    .all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.reserved);
  return m;
}

function listGlassSheets() {
  const reserved = glassReservedMap();
  return getDb().prepare('SELECT * FROM glass_sheets ORDER BY color').all()
    .map((r) => rowToGlassSheet(r, reserved.get(r.id) || 0));
}

// 以颜色键取规格（含库存视图）
function glassSheetMapByColor() {
  const m = new Map();
  for (const s of listGlassSheets()) m.set(s.color, s);
  return m;
}

function getGlassSheetRow(id) {
  return getDb().prepare('SELECT * FROM glass_sheets WHERE id = ?').get(id);
}

function getGlassSheetByColorRow(color) {
  return getDb().prepare('SELECT * FROM glass_sheets WHERE color = ?').get(color);
}

function getGlassSheet(id) {
  const row = getGlassSheetRow(id);
  if (!row) return null;
  const reserved = getDb()
    .prepare(`SELECT COALESCE(SUM(i.required_sheets),0) AS n
              FROM cut_order_items i JOIN cut_orders o ON o.id = i.order_id
              WHERE i.sheet_id = ? AND o.status = 'confirmed'`).get(id).n;
  return rowToGlassSheet(row, reserved);
}

function createGlassSheet({ color, width, height, stock }) {
  const info = getDb()
    .prepare('INSERT INTO glass_sheets (color, width_mm, height_mm, stock) VALUES (?, ?, ?, ?)')
    .run(color, width, height, stock);
  return getGlassSheet(info.lastInsertRowid);
}

// 仅允许调整库存张数（颜色/宽高均属规格身份）；库存不得低于已确认订单预留。
function updateGlassSheetStock(id, stock) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getGlassSheetRow(id);
    if (!row) return { code: 'not_found' };
    const reserved = d
      .prepare(`SELECT COALESCE(SUM(i.required_sheets),0) AS n
                FROM cut_order_items i JOIN cut_orders o ON o.id = i.order_id
                WHERE i.sheet_id = ? AND o.status = 'confirmed'`).get(id).n;
    if (stock < reserved) return { code: 'stock_below_reserved', reserved };
    d.prepare("UPDATE glass_sheets SET stock = ?, updated_at = datetime('now') WHERE id = ?").run(stock, id);
    return { code: 'ok', sheet: getGlassSheet(id) };
  });
  return txn.immediate();
}

// ---------- 裁片订单 ----------

function rowToCutOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    copies: row.copies,
    gap: row.gap_mm,
    totalSheets: row.total_sheets,
    layout: JSON.parse(row.layout),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    canceledAt: row.canceled_at || null,
    replacedAt: row.replaced_at || null,
    comboId: row.combo_id ?? null,
  };
}

function getCutOrderRow(id) {
  return getDb().prepare('SELECT * FROM cut_orders WHERE id = ?').get(id);
}

function getCutOrder(id) {
  return rowToCutOrder(getCutOrderRow(id));
}

function listCutOrders() {
  return getDb().prepare('SELECT * FROM cut_orders ORDER BY id DESC').all().map(rowToCutOrder);
}

function listCutOrderItems(orderId) {
  return getDb().prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(orderId)
    .map((r) => ({
      sheetId: r.sheet_id,
      color: r.sheet_color,
      sheetWidth: r.sheet_width_mm,
      sheetHeight: r.sheet_height_mm,
      requiredSheets: r.required_sheets,
    }));
}

// 建草稿订单。items: [{sheetId,color,width,height,requiredSheets}]
function createCutOrder(o) {
  const d = getDb();
  const txn = d.transaction(() => {
    const info = d.prepare(`INSERT INTO cut_orders
      (name, status, publication_id, design_id, version, copies, gap_mm, total_sheets, layout)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.name, o.publicationId, o.designId, o.version, o.copies, o.gap,
        o.totalSheets, JSON.stringify(o.layout));
    const id = info.lastInsertRowid;
    const ins = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      ins.run(id, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }
    return id;
  });
  const id = txn();
  return getCutOrder(id);
}

function updateCutOrderDraft(id, o) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getCutOrderRow(id);
    if (!row) return { code: 'not_found' };
    if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
    if (row.status !== 'draft') return { code: 'not_draft', status: row.status };
    d.prepare(`UPDATE cut_orders SET
       name = ?, publication_id = ?, design_id = ?, version = ?, copies = ?, gap_mm = ?,
       total_sheets = ?, layout = ?, updated_at = datetime('now')
     WHERE id = ?`)
      .run(o.name, o.publicationId, o.designId, o.version, o.copies, o.gap,
        o.totalSheets, JSON.stringify(o.layout), id);
    d.prepare('DELETE FROM cut_order_items WHERE order_id = ?').run(id);
    const ins = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      ins.run(id, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }
    return { code: 'ok', order: getCutOrder(id) };
  });
  return txn();
}

// 确认：在一个 BEGIN IMMEDIATE 事务中逐色核对并原子预留，任一颜色不足则整单失败。
function confirmCutOrder(id) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = getCutOrderRow(id);
    if (!row) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (row.combo_id) { d.exec('ROLLBACK'); return { code: 'combo_locked', comboId: row.combo_id }; }
    if (row.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'already_confirmed' }; }
    if (row.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'order_canceled' }; }
    if (row.status === 'replaced') { d.exec('ROLLBACK'); return { code: 'order_replaced' }; }

    const items = d.prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(id);
    const shortages = [];
    for (const it of items) {
      const sheet = getGlassSheetRow(it.sheet_id);
      if (!sheet) {
        d.exec('ROLLBACK');
        return { code: 'sheet_missing', color: it.sheet_color };
      }
      // 宽高身份双保险
      if (sheet.width_mm !== it.sheet_width_mm || sheet.height_mm !== it.sheet_height_mm) {
        d.exec('ROLLBACK');
        return { code: 'sheet_changed', color: it.sheet_color };
      }
      const reserved = d
        .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
                  FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
                  WHERE ci.sheet_id = ? AND co.status = 'confirmed'`).get(it.sheet_id).n;
      const available = sheet.stock - reserved;
      if (it.required_sheets > available) {
        shortages.push({
          color: it.sheet_color,
          required: it.required_sheets,
          available,
          shortage: it.required_sheets - available,
        });
      }
    }
    if (shortages.length) {
      d.exec('ROLLBACK');
      return { code: 'shortage', shortages };
    }
    d.prepare(`UPDATE cut_orders
      SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'`).run(id);
    d.exec('COMMIT');
    return { code: 'ok', order: getCutOrder(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消：只有已确认订单释放预留；重复取消不会再次改库存。
function cancelCutOrder(id) {
  const d = getDb();
  const row = getCutOrderRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status === 'draft') return { code: 'draft_not_reserved' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  if (row.status === 'replaced') return { code: 'order_replaced' };
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare(`UPDATE cut_orders
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(id);
    d.exec('COMMIT');
    return { code: 'ok', order: getCutOrder(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function deleteCutOrder(id) {
  const row = getCutOrderRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  if (row.status === 'replaced') return { code: 'replaced_delete_blocked' };
  getDb().prepare('DELETE FROM cut_orders WHERE id = ?').run(id); // 子表 ON DELETE CASCADE
  return { code: 'ok' };
}

// ---------- 裁片订单换单（已确认旧单 → 同一图纸另一已发布版本的新单） ----------

function getReplacementByOldOrder(oldOrderId) {
  return getDb()
    .prepare('SELECT * FROM cut_order_replacements WHERE old_order_id = ?')
    .get(oldOrderId) || null;
}

function getReplacementByNewOrder(newOrderId) {
  return getDb()
    .prepare('SELECT * FROM cut_order_replacements WHERE new_order_id = ?')
    .get(newOrderId) || null;
}

// 换单：一个 BEGIN IMMEDIATE 事务内
//   1) 旧单必须仍为 confirmed 且尚未换过；
//   2) 按“释放旧单预留后的库存”逐色核对新单（旧单本身的预留不再占库存）；
//   3) 任一颜色不足 → 回滚，旧单、库存、订单记录全部保持原状并返回各色缺口；
//   4) 充足 → 创建即 confirmed 的新单、旧单置为 replaced（同一原子提交）、写换单记录。
// 幂等：同旧单已有换单记录时，参数一致返回原新单（idempotent）；不一致返回 param_conflict。
// 参数 o: { name, targetPublicationId, designId, version, copies, gap, totalSheets, layout, items }
function replaceCutOrder(oldId, o) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const oldRow = getCutOrderRow(oldId);
    if (!oldRow) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (oldRow.combo_id) { d.exec('ROLLBACK'); return { code: 'combo_locked', comboId: oldRow.combo_id }; }

    // 已换过（旧单此时为 replaced）：相同参数幂等返回原新单；不同参数冲突。
    // 必须先于状态检查，保证“对同一旧单按相同参数重试返回原新单”。
    const existing = d
      .prepare('SELECT * FROM cut_order_replacements WHERE old_order_id = ?')
      .get(oldId);
    if (existing) {
      d.exec('ROLLBACK');
      const same = existing.target_publication_id === o.targetPublicationId &&
        existing.copies === o.copies && existing.gap_mm === o.gap;
      if (!same) {
        return {
          code: 'param_conflict',
          newOrderId: existing.new_order_id,
          current: {
            targetPublicationId: existing.target_publication_id,
            copies: existing.copies,
            gap: existing.gap_mm,
          },
        };
      }
      return { code: 'idempotent', order: getCutOrder(existing.new_order_id) };
    }

    if (oldRow.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'order_canceled' }; }
    if (oldRow.status === 'draft') { d.exec('ROLLBACK'); return { code: 'order_not_confirmed' }; }
    if (oldRow.status !== 'confirmed') { d.exec('ROLLBACK'); return { code: 'order_replaced' }; }

    // 逐色核对：把旧单视为即将释放，故可用量 = stock − 其他已确认单预留 + 旧单自身预留
    const shortages = [];
    for (const it of o.items) {
      const sheet = getGlassSheetRow(it.sheetId);
      if (!sheet) {
        d.exec('ROLLBACK');
        return { code: 'sheet_missing', color: it.color };
      }
      if (sheet.width_mm !== it.width || sheet.height_mm !== it.height) {
        d.exec('ROLLBACK');
        return { code: 'sheet_changed', color: it.color };
      }
      const reservedOther = d
        .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
                  FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
                  WHERE ci.sheet_id = ? AND co.status = 'confirmed' AND co.id <> ?`)
        .get(it.sheetId, oldId).n;
      const availableAfterRelease = sheet.stock - reservedOther;
      if (it.requiredSheets > availableAfterRelease) {
        shortages.push({
          color: it.color,
          required: it.requiredSheets,
          oldReserved: 0, // 下方统一回填旧单该色预留
          available: availableAfterRelease,
          shortage: it.requiredSheets - availableAfterRelease,
        });
      }
    }
    if (shortages.length) {
      // 回填旧单各色预留与净增减，便于客户端展示
      const oldItems = d.prepare('SELECT * FROM cut_order_items WHERE order_id = ?').all(oldId);
      const oldByColor = new Map(oldItems.map((it) => [it.sheet_color, it.required_sheets]));
      for (const s of shortages) s.oldReserved = oldByColor.get(s.color) || 0;
      d.exec('ROLLBACK');
      return { code: 'shortage', shortages };
    }

    // 创建新单（即 confirmed）
    const ins = d.prepare(`INSERT INTO cut_orders
      (name, status, publication_id, design_id, version, copies, gap_mm, total_sheets, layout, confirmed_at)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    const info = ins.run(o.name, o.targetPublicationId, o.designId, o.version,
      o.copies, o.gap, o.totalSheets, JSON.stringify(o.layout));
    const newId = info.lastInsertRowid;
    const insItem = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      insItem.run(newId, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }

    // 旧单退出预留（置为 replaced；原子提交前任何失败都整体回滚）
    d.prepare(`UPDATE cut_orders
      SET status = 'replaced', replaced_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(oldId);
    if (d.prepare('SELECT changes() AS n').get().n !== 1) {
      throw new Error('旧单状态在事务内发生意外变化');
    }

    d.prepare(`INSERT INTO cut_order_replacements
      (old_order_id, new_order_id, target_publication_id, copies, gap_mm)
      VALUES (?, ?, ?, ?, ?)`).run(oldId, newId, o.targetPublicationId, o.copies, o.gap);

    d.exec('COMMIT');
    return { code: 'ok', order: getCutOrder(newId), newOrderId: newId };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 整套用料单（铅条 + 玻璃 同一事务一次性核验并预留） ----------

function rowToComboOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    requestKey: row.request_key,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    copies: row.copies,
    kerf: row.kerf_h / 100,
    gap: row.gap_mm,
    materialId: row.material_id,
    requiredBars: row.required_bars,
    totalSheets: row.total_sheets,
    leadPlanId: row.lead_plan_id,
    cutOrderId: row.cut_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canceledAt: row.canceled_at || null,
  };
}

function getComboOrderRow(id) {
  return getDb().prepare('SELECT * FROM combo_orders WHERE id = ?').get(id);
}

function getComboOrder(id) {
  return rowToComboOrder(getComboOrderRow(id));
}

function getComboOrderByRequestKey(requestKey) {
  const row = getDb().prepare('SELECT * FROM combo_orders WHERE request_key = ?').get(requestKey);
  return row ? rowToComboOrder(row) : null;
}

function listComboOrders() {
  return getDb().prepare('SELECT * FROM combo_orders ORDER BY id DESC').all().map(rowToComboOrder);
}

// 确认整套单：一个 BEGIN IMMEDIATE 事务内
//   1) request_key 已存在：参数一致幂等返回原单；不一致返回 request_conflict；
//   2) 铅条原材：定尺身份核对 + 库存核对；
//   3) 玻璃各色：规格宽高身份核对 + 逐色库存核对；
//   4) 任一不足 → 回滚，两类库存、任何记录全部保持原状，返回铅条/各色缺口；
//   5) 充足 → 创建即 confirmed 的关联生产计划、关联裁片订单（含分色项）与整套单，原子提交。
// 参数 c:
//   { name, requestKey, publicationId, designId, version, copies, kerfH, gap,
//     materialId, materialName, materialLengthH, requiredBars, segmentCount, leadLayout,
//     totalSheets, nestLayout, items }
function createComboOrder(c) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    // 幂等 / 冲突（不重复排样、不重复预留）
    const dup = d.prepare('SELECT * FROM combo_orders WHERE request_key = ?').get(c.requestKey);
    if (dup) {
      d.exec('ROLLBACK');
      const same = dup.publication_id === c.publicationId &&
        dup.material_id === c.materialId &&
        dup.copies === c.copies && dup.kerf_h === c.kerfH && dup.gap_mm === c.gap;
      if (!same) {
        return {
          code: 'request_conflict',
          comboId: dup.id,
          current: {
            publicationId: dup.publication_id, materialId: dup.material_id,
            copies: dup.copies, kerf: dup.kerf_h / 100, gap: dup.gap_mm,
          },
        };
      }
      return { code: 'idempotent', combo: rowToComboOrder(dup) };
    }

    // ---- 铅条：身份与库存 ----
    const mat = getMaterialRow(c.materialId);
    if (!mat) { d.exec('ROLLBACK'); return { code: 'material_missing' }; }
    if (mat.length_h !== c.materialLengthH) { d.exec('ROLLBACK'); return { code: 'material_changed' }; }
    const leadReserved = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(c.materialId).n;
    const leadAvailable = mat.stock - leadReserved;
    if (c.requiredBars > leadAvailable) {
      d.exec('ROLLBACK');
      return {
        code: 'shortage',
        lead: { required: c.requiredBars, available: leadAvailable, shortage: c.requiredBars - leadAvailable },
        glass: [],
      };
    }

    // ---- 玻璃：逐色身份与库存 ----
    const glassShortages = [];
    for (const it of c.items) {
      const sheet = getGlassSheetRow(it.sheetId);
      if (!sheet) { d.exec('ROLLBACK'); return { code: 'sheet_missing', color: it.color }; }
      if (sheet.width_mm !== it.width || sheet.height_mm !== it.height) {
        d.exec('ROLLBACK'); return { code: 'sheet_changed', color: it.color };
      }
      const reserved = d
        .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
                  FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
                  WHERE ci.sheet_id = ? AND co.status = 'confirmed'`).get(it.sheetId).n;
      const available = sheet.stock - reserved;
      if (it.requiredSheets > available) {
        glassShortages.push({
          color: it.color, required: it.requiredSheets,
          available, shortage: it.requiredSheets - available,
        });
      }
    }
    if (glassShortages.length) {
      d.exec('ROLLBACK');
      return {
        code: 'shortage',
        lead: { required: c.requiredBars, available: leadAvailable, shortage: 0 },
        glass: glassShortages,
      };
    }

    // ---- 充足：创建关联生产计划（即 confirmed） ----
    const planInfo = d.prepare(`INSERT INTO lead_plans
      (name, status, publication_id, design_id, version, material_id, material_name,
       material_length_h, copies, kerf_h, required_bars, segment_count, layout, confirmed_at, combo_id)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)`)
      .run(c.leadName, c.publicationId, c.designId, c.version, c.materialId,
        c.materialName, c.materialLengthH, c.copies, c.kerfH, c.requiredBars,
        c.segmentCount, JSON.stringify(c.leadLayout));
    const planId = planInfo.lastInsertRowid;

    // ---- 创建关联裁片订单（即 confirmed） ----
    const orderInfo = d.prepare(`INSERT INTO cut_orders
      (name, status, publication_id, design_id, version, copies, gap_mm, total_sheets, layout, confirmed_at, combo_id)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)`)
      .run(c.orderName, c.publicationId, c.designId, c.version, c.copies, c.gap,
        c.totalSheets, JSON.stringify(c.nestLayout));
    const orderId = orderInfo.lastInsertRowid;

    const insItem = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of c.items) {
      insItem.run(orderId, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }

    // ---- 整套单（回填两个关联 id） ----
    const comboInfo = d.prepare(`INSERT INTO combo_orders
      (name, status, request_key, publication_id, design_id, version, copies, kerf_h, gap_mm,
       material_id, required_bars, total_sheets, lead_plan_id, cut_order_id)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.name, c.requestKey, c.publicationId, c.designId, c.version,
        c.copies, c.kerfH, c.gap, c.materialId, c.requiredBars, c.totalSheets, planId, orderId);
    const comboId = comboInfo.lastInsertRowid;

    d.prepare('UPDATE lead_plans SET combo_id = ? WHERE id = ?').run(comboId, planId);
    d.prepare('UPDATE cut_orders SET combo_id = ? WHERE id = ?').run(comboId, orderId);

    d.exec('COMMIT');
    return { code: 'ok', combo: getComboOrder(comboId) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消整套单：同一事务把关联生产计划与裁片订单同时置为 canceled，
// 两类预留各释放一次；重复取消不重复变更库存。
function cancelComboOrder(id) {
  const d = getDb();
  const row = getComboOrderRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  d.exec('BEGIN IMMEDIATE');
  try {
    // 事务内重读状态，防止并发重复取消
    const cur = d.prepare('SELECT * FROM combo_orders WHERE id = ?').get(id);
    if (cur.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'already_canceled' }; }

    const pn = d.prepare(`UPDATE lead_plans
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND combo_id = ? AND status = 'confirmed'`).run(cur.lead_plan_id, id);
    const on = d.prepare(`UPDATE cut_orders
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND combo_id = ? AND status = 'confirmed'`).run(cur.cut_order_id, id);
    if (pn.changes !== 1 || on.changes !== 1) {
      throw new Error('整套单关联记录状态异常，取消已回滚');
    }
    d.prepare(`UPDATE combo_orders
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`).run(id);
    d.exec('COMMIT');
    return { code: 'ok', combo: getComboOrder(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 库存盘点（铅条 + 玻璃 同一张盘点单） ----------

function rowToStocktake(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
  };
}

function getStocktakeRow(id) {
  return getDb().prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
}

function getStocktake(id) {
  return rowToStocktake(getStocktakeRow(id));
}

function listStocktakes() {
  return getDb().prepare('SELECT * FROM stocktakes ORDER BY id DESC').all().map(rowToStocktake);
}

function listStocktakeItemRows(stocktakeId) {
  return getDb()
    .prepare('SELECT * FROM stocktake_items WHERE stocktake_id = ? ORDER BY id')
    .all(stocktakeId);
}

// 单规格当前已被已确认计划/订单预留的数量（独立单与整套单关联单同一口径，按状态计）。
function leadReservedFor(materialId) {
  return getDb()
    .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(materialId).n;
}

function glassReservedFor(sheetId) {
  return getDb()
    .prepare(`SELECT COALESCE(SUM(i.required_sheets),0) AS n
              FROM cut_order_items i JOIN cut_orders o ON o.id = i.order_id
              WHERE i.sheet_id = ? AND o.status = 'confirmed'`).get(sheetId).n;
}

// 生成某一项的预览基准（系统库存、已确认预留、规格身份快照）。
// 规格不存在返回 { code:'not_found' }。
function stocktakeBaseline(type, specId) {
  if (type === 'lead') {
    const m = getMaterialRow(specId);
    if (!m) return { code: 'not_found' };
    return {
      specName: m.name, specLengthH: m.length_h,
      specWidthMm: null, specHeightMm: null,
      stock: m.stock, reserved: leadReservedFor(specId),
    };
  }
  const s = getGlassSheetRow(specId);
  if (!s) return { code: 'not_found' };
  return {
    specName: s.color, specLengthH: null,
    specWidthMm: s.width_mm, specHeightMm: s.height_mm,
    stock: s.stock, reserved: glassReservedFor(specId),
  };
}

// 建草稿盘点单并固化各项预览基准（同一事务）。
// items: [{type:'lead'|'glass', specId, counted}]（调用方已校验非空、不重复、实盘非负整数）。
function createStocktake({ name, items }) {
  const d = getDb();
  const txn = d.transaction(() => {
    // 取基准（事务内）；规格不存在或同单重复均整体拒绝，不落任何记录
    const rows = items.map((it) => {
      const b = stocktakeBaseline(it.type, it.specId);
      if (b.code === 'not_found') {
        return { fail: { code: 'not_found', type: it.type, specId: it.specId } };
      }
      return { ...it, ...b };
    });
    const failed = rows.find((r) => r.fail);
    if (failed) return failed.fail;

    const info = d.prepare("INSERT INTO stocktakes (name, status) VALUES (?, 'draft')").run(name);
    const id = info.lastInsertRowid;
    const ins = d.prepare(`INSERT INTO stocktake_items
      (stocktake_id, type, spec_id, spec_name, spec_length_h, spec_width_mm, spec_height_mm,
       baseline_stock, baseline_reserved, counted_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      ins.run(id, r.type, r.specId, r.specName, r.specLengthH, r.specWidthMm, r.specHeightMm,
        r.stock, r.reserved, r.counted);
    }
    return { code: 'ok', id };
  });
  return txn.immediate();
}

// 修改草稿盘点单（换规格/改实盘数）：按新的项重新固化预览基准。
// 已确认盘点单不可修改；草稿删除后重写全部项。
function updateStocktakeDraft(id, { name, items }) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getStocktakeRow(id);
    if (!row) return { code: 'not_found' };
    if (row.status === 'confirmed') return { code: 'already_confirmed' };

    const rows = items.map((it) => {
      const b = stocktakeBaseline(it.type, it.specId);
      if (b.code === 'not_found') {
        return { fail: { code: 'not_found', type: it.type, specId: it.specId } };
      }
      return { ...it, ...b };
    });
    const failed = rows.find((r) => r.fail);
    if (failed) return failed.fail;

    d.prepare("UPDATE stocktakes SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    d.prepare('DELETE FROM stocktake_items WHERE stocktake_id = ?').run(id);
    const ins = d.prepare(`INSERT INTO stocktake_items
      (stocktake_id, type, spec_id, spec_name, spec_length_h, spec_width_mm, spec_height_mm,
       baseline_stock, baseline_reserved, counted_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      ins.run(id, r.type, r.specId, r.specName, r.specLengthH, r.specWidthMm, r.specHeightMm,
        r.stock, r.reserved, r.counted);
    }
    return { code: 'ok' };
  });
  return txn.immediate();
}

// 确认盘点：一个 BEGIN IMMEDIATE 事务内对所有项重核库存与预留：
//   1) 规格必须仍存在（spec_missing）、规格身份未变（spec_changed：铅条定尺/玻璃宽高）；
//   2) 当前系统库存必须与预览基准一致（stock_changed）；
//   3) 当前已确认预留必须与预览基准一致（reserved_changed）；
//   4) 实盘数不得低于当前预留（below_reserved）；
// 任一项不符即整单不生效（返回全部问题项及原因），全部通过才一次更新各规格库存并置为已确认。
// 已确认单重复确认幂等返回原单（idempotent），不再调整库存。
function confirmStocktake(id) {
  const d = getDb();
  const row = getStocktakeRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'confirmed') return { code: 'idempotent' };

  d.exec('BEGIN IMMEDIATE');
  try {
    const cur = getStocktakeRow(id);
    if (!cur) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (cur.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'idempotent' }; }

    const itemRows = listStocktakeItemRows(id);
    const problems = [];
    for (const it of itemRows) {
      if (it.type === 'lead') {
        const m = getMaterialRow(it.spec_id);
        if (!m) { problems.push(problem(it, 'spec_missing', '规格已不存在')); continue; }
        if (m.length_h !== it.spec_length_h) {
          problems.push(problem(it, 'spec_changed', '原材定尺与预览基准不一致'));
          continue;
        }
        const reserved = leadReservedFor(it.spec_id);
        if (m.stock !== it.baseline_stock) {
          problems.push(problem(it, 'stock_changed', '系统库存与预览基准不一致（预览后库存已变动）',
            { currentStock: m.stock, currentReserved: reserved }));
          continue;
        }
        if (reserved !== it.baseline_reserved) {
          problems.push(problem(it, 'reserved_changed', '已确认预留与预览基准不一致（预览后有计划/订单确认或取消）',
            { currentStock: m.stock, currentReserved: reserved }));
          continue;
        }
        if (it.counted_stock < reserved) {
          problems.push(problem(it, 'below_reserved', '实盘数低于当前已确认预留，不能按此盘点',
            { currentStock: m.stock, currentReserved: reserved }));
        }
      } else {
        const s = getGlassSheetRow(it.spec_id);
        if (!s) { problems.push(problem(it, 'spec_missing', '颜色原片规格已不存在')); continue; }
        if (s.width_mm !== it.spec_width_mm || s.height_mm !== it.spec_height_mm) {
          problems.push(problem(it, 'spec_changed', '原片宽高与预览基准不一致'));
          continue;
        }
        const reserved = glassReservedFor(it.spec_id);
        if (s.stock !== it.baseline_stock) {
          problems.push(problem(it, 'stock_changed', '系统库存与预览基准不一致（预览后库存已变动）',
            { currentStock: s.stock, currentReserved: reserved }));
          continue;
        }
        if (reserved !== it.baseline_reserved) {
          problems.push(problem(it, 'reserved_changed', '已确认预留与预览基准不一致（预览后有订单确认或取消）',
            { currentStock: s.stock, currentReserved: reserved }));
          continue;
        }
        if (it.counted_stock < reserved) {
          problems.push(problem(it, 'below_reserved', '实盘数低于当前已确认预留，不能按此盘点',
            { currentStock: s.stock, currentReserved: reserved }));
        }
      }
    }
    if (problems.length) {
      d.exec('ROLLBACK');
      return { code: 'baseline_mismatch', items: problems };
    }

    // 全部通过：一次更新各规格库存（独立计划、裁片订单与整套单随后按盘点后库存计算可用量）
    for (const it of itemRows) {
      if (it.type === 'lead') {
        d.prepare("UPDATE lead_materials SET stock = ?, updated_at = datetime('now') WHERE id = ?")
          .run(it.counted_stock, it.spec_id);
      } else {
        d.prepare("UPDATE glass_sheets SET stock = ?, updated_at = datetime('now') WHERE id = ?")
          .run(it.counted_stock, it.spec_id);
      }
    }
    d.prepare(`UPDATE stocktakes SET status = 'confirmed', confirmed_at = datetime('now'),
      updated_at = datetime('now') WHERE id = ?`).run(id);
    d.exec('COMMIT');
    return { code: 'ok' };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function problem(it, reason, message, extra = {}) {
  return {
    itemId: it.id,
    type: it.type,
    specId: it.spec_id,
    reason,
    message,
    baselineStock: it.baseline_stock,
    baselineReserved: it.baseline_reserved,
    countedStock: it.counted_stock,
    ...extra,
  };
}

// 删除盘点单：仅草稿可删（已确认为永久记录，仅可查阅）。
function deleteStocktake(id) {
  const row = getStocktakeRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  const d = getDb();
  const txn = d.transaction(() => {
    d.prepare('DELETE FROM stocktake_items WHERE stocktake_id = ?').run(id);
    d.prepare('DELETE FROM stocktakes WHERE id = ?').run(id);
  });
  txn();
  return { code: 'ok' };
}

module.exports = {
  init, getDb,
  createDesign, getDesign, listDesigns,
  listPieces, getPiece, addPiece, updatePiece, deletePiece, replaceAllPieces,
  publishVersion, getPublication, getPublicationByVersion, getPublicationById, listPublications,
  listMaterials, getMaterial, getMaterialRow, getMaterialByName, createMaterial, updateMaterial,
  createPlan, getPlan, listPlans, updatePlanDraft, confirmPlan, cancelPlan, deletePlan,
  listGlassSheets, glassSheetMapByColor, getGlassSheet, getGlassSheetRow, getGlassSheetByColorRow,
  createGlassSheet, updateGlassSheetStock,
  createCutOrder, getCutOrder, listCutOrders, listCutOrderItems, updateCutOrderDraft,
  confirmCutOrder, cancelCutOrder, deleteCutOrder,
  getReplacementByOldOrder, getReplacementByNewOrder, replaceCutOrder,
  createComboOrder, getComboOrder, listComboOrders, cancelComboOrder,
  createStocktake, updateStocktakeDraft, confirmStocktake, deleteStocktake,
  getStocktake, getStocktakeRow, listStocktakes, listStocktakeItemRows,
  leadReservedFor, glassReservedFor,
};
