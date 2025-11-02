// src/migrations/20251101_001_turns_table.js
export async function up(knex) {
  // 1) Tabla de turnos (auditoría liviana)
  await knex.schema.createTable('aurum_turns', (t) => {
    t.bigIncrements('id').unsigned().primary();

    t.integer('user_id').notNullable();
    t.string('telefono', 32).notNullable();
    t.string('instancia_evolution_api', 64).notNullable();
    t.string('dominio', 128).notNullable();

    t.string('msg_id', 128).notNullable();       // idempotencia por conversación
    t.string('direction', 8).nullable();         // "in" | "out"
    t.text('text').nullable();

    // JSON como TEXT para máxima compatibilidad MySQL
    t.text('blocks_json').nullable();
    t.text('marketing_state_json').nullable();

    t.dateTime('ts').nullable();                 // timestamp del turno (si lo envía n8n)

    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());

    // índices
    t.index(['user_id', 'telefono', 'instancia_evolution_api', 'dominio'], 'idx_turn_conv');

    // único por conversación + msg_id (idempotencia)
    t.unique(['user_id', 'telefono', 'instancia_evolution_api', 'dominio', 'msg_id'], 'uniq_turn_msg');
  });

  // 2) Snapshot de marketing en conversaciones (JSON como TEXT)
  const hasCol = await knex.schema.hasColumn('aurum_conversations', 'marketing_state_json');
  if (!hasCol) {
    await knex.schema.alterTable('aurum_conversations', (t) => {
      t.text('marketing_state_json').nullable().after('working_window');
    });
  }
}

export async function down(knex) {
  // revertir cambios
  const hasCol = await knex.schema.hasColumn('aurum_conversations', 'marketing_state_json');
  if (hasCol) {
    await knex.schema.alterTable('aurum_conversations', (t) => {
      t.dropColumn('marketing_state_json');
    });
  }
  await knex.schema.dropTableIfExists('aurum_turns');
}
