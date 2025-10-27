// migrations/20251027_001_followups_queue_schema.js
/**
 * Consolida el esquema de aurum_followups_queue:
 *  - id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY
 *  - índice por conversación (user_id, telefono, instancia_evolution_api, dominio)
 *  - índice por (scheduled_at, status)
 *  - índice por kind (opcional, útil para filtros)
 *
 * Es segura si los índices/PK ya existen: hace "create if missing".
 */

async function hasAutoIncrement(knex) {
  const [rows] = await knex.raw(`
    SELECT EXTRA
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'aurum_followups_queue'
      AND COLUMN_NAME = 'id'
    LIMIT 1
  `);
  const r = Array.isArray(rows) ? rows[0] : rows;
  return r && String(r.EXTRA || '').toLowerCase().includes('auto_increment');
}

async function indexExists(knex, indexName) {
  const [rows] = await knex.raw(`
    SHOW INDEX FROM aurum_followups_queue
  `);
  if (!rows || !rows.length) return false;
  return rows.some(r => String(r.Key_name) === indexName);
}

async function primaryKeyColumns(knex) {
  const [rows] = await knex.raw(`
    SHOW KEYS FROM aurum_followups_queue WHERE Key_name = 'PRIMARY'
  `);
  if (!rows || !rows.length) return [];
  // Puede devolver varias filas (una por columna)
  return rows.sort((a,b) => a.Seq_in_index - b.Seq_in_index).map(r => r.Column_name);
}

exports.up = async function up(knex) {
  // 1) Asegurar AUTO_INCREMENT en id
  const ai = await hasAutoIncrement(knex);
  if (!ai) {
    // Si no es AI, verificamos la PK actual
    const pkCols = await primaryKeyColumns(knex);
    if (pkCols.length && !(pkCols.length === 1 && pkCols[0] === 'id')) {
      // Si la PK no es (id) → la cambiamos a (id)
      await knex.schema.raw(`
        ALTER TABLE aurum_followups_queue
        DROP PRIMARY KEY,
        MODIFY id BIGINT(20) UNSIGNED NOT NULL,
        ADD PRIMARY KEY (id)
      `);
    }
    // Convertir a AUTO_INCREMENT si aún no lo es
    await knex.schema.raw(`
      ALTER TABLE aurum_followups_queue
      MODIFY id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT
    `);
  }

  // 2) Índice por conversación
  const idxConv = await indexExists(knex, 'idx_afq_conv');
  if (!idxConv) {
    await knex.schema.raw(`
      ALTER TABLE aurum_followups_queue
      ADD INDEX idx_afq_conv (user_id, telefono, instancia_evolution_api, dominio)
    `);
  }

  // 3) Índice por scheduled_at + status (para listados y housekeeping)
  const idxSched = await indexExists(knex, 'idx_afq_sched_status');
  if (!idxSched) {
    await knex.schema.raw(`
      ALTER TABLE aurum_followups_queue
      ADD INDEX idx_afq_sched_status (scheduled_at, status)
    `);
  }

  // 4) Índice por kind (útil para filtros por tipo)
  const idxKind = await indexExists(knex, 'idx_afq_kind');
  if (!idxKind) {
    await knex.schema.raw(`
      ALTER TABLE aurum_followups_queue
      ADD INDEX idx_afq_kind (kind)
    `);
  }
};

exports.down = async function down(knex) {
  // Revertir AI y PK no es deseable en prod; solo limpiamos el idx_kind opcional.
  const idxKind = await knex.schema.raw(`SHOW INDEX FROM aurum_followups_queue`);
  const [rows] = idxKind;
  const hasIdxKind = rows && rows.some(r => String(r.Key_name) === 'idx_afq_kind');
  if (hasIdxKind) {
    await knex.schema.raw(`ALTER TABLE aurum_followups_queue DROP INDEX idx_afq_kind`);
  }
};
