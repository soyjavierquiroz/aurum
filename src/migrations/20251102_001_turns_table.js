// src/migrations/20251102_001_turns_table.js
/**
 * Crea tabla aurum_turns (log de turnos) e incorpora marketing_state_json en aurum_conversations.
 * Compatible con MySQL 5.7/8. Si tu MySQL no soporta JSON, cambia .json() por .text().
 */

export async function up(knex) {
  // 1) aurum_turns
  const hasTurns = await knex.schema.hasTable('aurum_turns');
  if (!hasTurns) {
    await knex.schema.createTable('aurum_turns', (t) => {
      t.bigIncrements('id').unsigned().primary();

      t.integer('user_id').notNullable();
      t.string('telefono', 32).notNullable();
      t.string('instancia_evolution_api', 64).notNullable();
      t.string('dominio', 128).notNullable();

      t.string('msg_id', 191).notNullable(); // para idempotencia por conversación
      t.string('direction', 8).nullable();   // "in" | "out"
      t.text('text').nullable();

      // JSON con bloques del orquestador (final_whatsapp_reply, proposals, etc.)
      t.json('blocks_json').nullable();

      // JSON con el "estado de marketing" del turno (scoring/categorías)
      t.json('marketing_state_json').nullable();

      t.dateTime('ts').nullable();

      t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
      t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());

      t.index(['user_id', 'telefono', 'instancia_evolution_api', 'dominio'], 'idx_turns_conv');
      t.unique(['user_id', 'telefono', 'instancia_evolution_api', 'dominio', 'msg_id'], 'uniq_turns_conv_msg');
    })
    // si tu MySQL soporta, estas dos líneas ayudan (no fallan si no aplica):
    .charset?.('utf8mb4')
    ?.engine?.('InnoDB');
  }

  // 2) aurum_conversations.marketing_state_json (opcional para snapshot por conversación)
  const hasCol = await knex.schema.hasColumn('aurum_conversations', 'marketing_state_json');
  if (!hasCol) {
    await knex.schema.alterTable('aurum_conversations', (t) => {
      t.json('marketing_state_json').nullable().after('working_window'); // mover si la columna no existe
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

  const hasTurns = await knex.schema.hasTable('aurum_turns');
  if (hasTurns) {
    await knex.schema.dropTable('aurum_turns');
  }
}
